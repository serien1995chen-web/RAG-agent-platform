/**
 * @kb/parse 格式注册表与共享解析基础设施（设计文档 9.8.1）。
 * 本文件是 @kb/parse 的唯一共享底层：冻结类型与 9 类格式矩阵、解析器注册表、
 * 编码探测/文本解码/Markdown 表格工具，以及最小 zip 读取器。作为叶子模块，
 * 它不 import 任何本地模块，避免 barrel 循环依赖。
 * 未登记格式 KNOWLEDGE_UNSUPPORTED_CONTENT，解析失败不得静默降级。
 * 无自带类型的解析依赖（papaparse/turndown/joplin-gfm/yauzl）在各使用点以带类型断言的
 * 动态 import 引入：TypeScript 禁止在模块文件内声明 ambient module（TS2665），
 * 且不新增 .d.ts 或运行时依赖。
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  createKnowledgeError,
  type KnowledgeApiError,
  type KnowledgeErrorCode,
} from '@kb/contracts';

// ---------------------------------------------------------------------------
// 冻结类型与 9 类格式矩阵（设计文档 9.8.1）
// ---------------------------------------------------------------------------

export interface ParseFormatSpec {
  format: string;
  extensions: readonly string[];
  parser: string;
  fallback: string;
}

export const PARSE_FORMAT_MATRIX: readonly ParseFormatSpec[] = [
  { format: 'text', extensions: ['txt'], parser: 'native-text', fallback: 'rawText' },
  {
    format: 'markdown',
    extensions: ['md', 'markdown'],
    parser: 'native-markdown',
    fallback: 'rawText',
  },
  {
    format: 'html',
    extensions: ['html', 'htm'],
    parser: 'html-to-markdown',
    fallback: 'plain-text',
  },
  {
    format: 'pdf',
    extensions: ['pdf'],
    parser: 'pdf-text-layer',
    fallback: 'pdf-enhance-provider',
  },
  { format: 'docx', extensions: ['docx'], parser: 'docx-parser', fallback: 'none' },
  { format: 'pptx', extensions: ['pptx'], parser: 'pptx-parser', fallback: 'none' },
  { format: 'xlsx', extensions: ['xlsx'], parser: 'xlsx-precheck', fallback: 'none' },
  { format: 'csv', extensions: ['csv'], parser: 'csv-parser', fallback: 'none' },
  { format: 'ebook', extensions: ['epub'], parser: 'document-parser-port', fallback: 'none' },
  { format: 'ofd', extensions: ['ofd'], parser: 'ofd-parser', fallback: 'none' },
];

export interface ParseRequest {
  workspaceId: string;
  knowledgeSpaceId: string;
  sourceId: string;
  fileRef: string;
  extension: string;
  mimeType?: string;
  timeoutMs: number;
}

export interface ParseResult {
  format: string;
  rawText: string;
  pages: ParsePage[];
  assets: ParseAsset[];
  diagnostics: ParseDiagnostic[];
  scanRequired: boolean;
  imageRefs: string[];
  contentHash: string;
  parserVersion: string;
  configHash: string;
}

export interface ParseAsset {
  assetId: string;
  mimeType: string;
  sha256: string;
  sizeBytes: number;
  objectRefId?: string;
  /** Internal bytes used by the service artifact materializer; never part of C2 serialization. */
  bytes?: Uint8Array;
}

export interface ParsePage {
  pageNumber: number;
  text: string;
  assets: ParseAsset[];
}

export interface ParseDiagnostic {
  severity: 'info' | 'warning' | 'error';
  code: string;
  path?: string;
  page?: number;
}

export interface ParseEvidence {
  parserVersion: string;
  configHash: string;
}

/** 扩展格式必须实现该 Port；未注册格式不得静默降级为普通文本。 */
export interface DocumentParserPort {
  parse(request: ParseRequest): Promise<ParseResult>;
}

export function resolveParseFormat(extension: string): ParseFormatSpec | null {
  const normalized = extension.replace(/^\./, '').toLowerCase();
  return (
    PARSE_FORMAT_MATRIX.find((spec) =>
      (spec.extensions as readonly string[]).includes(normalized),
    ) ?? null
  );
}

/** 稳定内容哈希：同一文本 → 同一 contentHash（用于 Chunk/QA 依赖）。 */
export function contentHashOf(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

// ---------------------------------------------------------------------------
// 解析器注册表
// ---------------------------------------------------------------------------

export type ParseFormat =
  | 'text'
  | 'markdown'
  | 'html'
  | 'pdf'
  | 'docx'
  | 'pptx'
  | 'xlsx'
  | 'csv'
  | 'ebook'
  | 'ofd';

export interface ParseHandlerContext {
  request: ParseRequest;
  bytes: Uint8Array;
  mimeType?: string;
  /** 由集成层注入；用于内嵌图片入对象存储或 PDF Provider。 */
  objectStore?: objectStoreLike;
  /** PDF 无文本层时回调（走 PdfEnhanceProviderPort）。 */
  enhanceScannedPdf?: (bytes: Uint8Array, request: ParseRequest) => Promise<ParseResult>;
}

/** 仅声明所需能力，避免 @kb/parse 直接依赖 service Port 类型。 */
export interface objectStoreLike {
  putObject?: (input: { key: string; body: Uint8Array; contentType?: string }) => Promise<string>;
}

export type ParseHandler = (context: ParseHandlerContext) => Promise<ParseResult>;

export interface ParseFormatRegistration {
  spec: ParseFormatSpec;
  handler: ParseHandler;
}

const MIME_BY_FORMAT: Record<ParseFormat, readonly string[]> = {
  text: ['text/plain'],
  markdown: ['text/markdown', 'text/x-markdown'],
  html: ['text/html', 'application/xhtml+xml'],
  pdf: ['application/pdf'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  csv: ['text/csv', 'application/csv'],
  ebook: ['application/epub+zip'],
  ofd: ['application/ofd', 'application/ofd+xml'],
};

/** 归一化扩展名：去前导点、小写。 */
export function normalizeExtension(extension: string): string {
  return extension.replace(/^\./, '').trim().toLowerCase();
}

/** 归一化 MIME：去 parameters（; charset=...）并小写。 */
export function normalizeMimeType(mimeType: string | undefined): string | undefined {
  if (!mimeType) return undefined;
  const base = mimeType.split(';')[0];
  return base ? base.trim().toLowerCase() : undefined;
}

export function parseError(
  code: KnowledgeErrorCode,
  requestId: string,
  params: Record<string, unknown> = {},
): KnowledgeApiError {
  return createKnowledgeError({
    code,
    requestId,
    traceId: requestId,
    details: params,
  });
}

export function unsupportedFormatError(extension: string, requestId: string): KnowledgeApiError {
  return parseError('KNOWLEDGE_UNSUPPORTED_CONTENT', requestId, {
    extension: normalizeExtension(extension) || extension,
  });
}

export function parseFailedError(
  extension: string,
  reason: string,
  requestId: string,
): KnowledgeApiError {
  return parseError('KNOWLEDGE_UNSUPPORTED_CONTENT', requestId, {
    extension: normalizeExtension(extension),
    reason,
  });
}

/** 注册表：以 format 为键，每个矩阵项必须恰好注册一个 handler。 */
export class ParseFormatRegistry {
  private readonly byFormat = new Map<ParseFormat, ParseFormatRegistration>();
  private readonly byExtension = new Map<string, ParseFormat>();
  private readonly byMime = new Map<string, ParseFormat>();

  register(format: ParseFormat, handler: ParseHandler): void {
    const spec = PARSE_FORMAT_MATRIX.find((item) => item.format === format);
    if (!spec) {
      throw parseError('KNOWLEDGE_VALIDATION_FAILED', format, {
        extension: format,
        reason: 'format_not_in_matrix',
      });
    }
    if (this.byFormat.has(format)) {
      throw parseError('KNOWLEDGE_CONFLICT', format, {
        extension: format,
        reason: 'format_already_registered',
      });
    }
    this.byFormat.set(format, { spec, handler });
    for (const extension of spec.extensions) {
      this.byExtension.set(normalizeExtension(extension), format);
    }
    for (const mime of MIME_BY_FORMAT[format]) {
      this.byMime.set(mime, format);
    }
  }

  resolveByExtension(extension: string): ParseFormat | null {
    const normalized = normalizeExtension(extension);
    if (normalized.length === 0) return null;
    return this.byExtension.get(normalized) ?? null;
  }

  resolveByMime(mimeType: string | undefined): ParseFormat | null {
    const normalized = normalizeMimeType(mimeType);
    if (!normalized) return null;
    return this.byMime.get(normalized) ?? null;
  }

  resolve(extension: string, mimeType?: string): ParseFormat | null {
    return this.resolveByExtension(extension) ?? this.resolveByMime(mimeType);
  }

  get(format: ParseFormat): ParseFormatRegistration | null {
    return this.byFormat.get(format) ?? null;
  }

  entries(): ParseFormatRegistration[] {
    return [...this.byFormat.values()];
  }

  get size(): number {
    return this.byFormat.size;
  }
}

// ---------------------------------------------------------------------------
// 解析公共工具：编码探测、文本解码、Markdown 表格（设计文档 9.8.1）
// ---------------------------------------------------------------------------

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;
const UTF16LE_BOM = [0xff, 0xfe] as const;
const UTF16BE_BOM = [0xfe, 0xff] as const;

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, index) => bytes[index] === byte);
}

export type DetectedEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030';

const CHARSET_RE = /charset\s*=\s*[^a-z0-9]?\s*([a-z0-9_-]+)/i;

/** 编码探测优先级：BOM → charset 声明 → 统计探测 → UTF-8 兜底。 */
export function detectEncoding(bytes: Uint8Array): DetectedEncoding {
  if (startsWith(bytes, UTF8_BOM)) return 'utf-8';
  if (startsWith(bytes, UTF16LE_BOM)) return 'utf-16le';
  if (startsWith(bytes, UTF16BE_BOM)) return 'utf-16be';

  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, 4096))
    .toLowerCase();
  const declared = CHARSET_RE.exec(head)?.[1];
  if (declared) {
    if (declared === 'utf-8' || declared === 'utf8') return 'utf-8';
    if (declared === 'gbk' || declared === 'gb2312' || declared === 'gb18030') return 'gb18030';
    if (declared === 'utf-16' || declared === 'utf-16le') return 'utf-16le';
    if (declared === 'utf-16be') return 'utf-16be';
  }

  const sample = bytes.subarray(0, 8192);
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(sample);
  let replacement = 0;
  for (const char of decoded) if (char === '\ufffd') replacement += 1;
  if (decoded.length > 0 && replacement / decoded.length > 0.01) return 'gb18030';
  return 'utf-8';
}

/** 解码文本：非法字节以 U+FFFD 替换（告警由调用方记录），并去 BOM。 */
export function decodeText(
  bytes: Uint8Array,
  encoding: DetectedEncoding = detectEncoding(bytes),
): string {
  let text = new TextDecoder(encoding, { fatal: false }).decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** 归一化换行与零宽字符；折叠 3+ 连续换行。 */
export function normalizeRawText(text: string): string {
  return normalizeNewlines(text)
    .replace(/\u200b|\u200c|\u200d|\u2060|\ufeff/g, '')
    .replace(/\n{3,}/g, '\n\n');
}

export function makeResult(
  format: string,
  rawText: string,
  options: {
    scanRequired?: boolean;
    imageRefs?: string[];
    pages?: ParsePage[];
    assets?: ParseAsset[];
    diagnostics?: ParseDiagnostic[];
    parserVersion?: string;
    configHash?: string;
  } = {},
): ParseResult {
  const assets = options.assets ?? [];
  const pages =
    options.pages ?? (rawText.length === 0 ? [] : [{ pageNumber: 1, text: rawText, assets }]);
  return {
    format,
    rawText,
    pages,
    assets,
    diagnostics: options.diagnostics ?? [],
    scanRequired: options.scanRequired ?? false,
    imageRefs: options.imageRefs ?? [],
    contentHash: contentHashOf(rawText),
    parserVersion: options.parserVersion ?? `native-${format}@1`,
    configHash:
      options.configHash ??
      contentHashOf(
        JSON.stringify({
          format,
          scanRequired: options.scanRequired ?? false,
          parserVersion: options.parserVersion ?? `native-${format}@1`,
        }),
      ),
  };
}

/** Markdown 表格转义：单元格内换行/竖线归一化。 */
export function mdCell(value: string): string {
  return normalizeNewlines(value).replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
}

export function toMarkdownTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const header = `| ${headers.map(mdCell).join(' | ')} |`;
  const divider = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.map(mdCell).join(' | ')} |`);
  return [header, divider, ...body].join('\n');
}

// ---------------------------------------------------------------------------
// 最小 zip 读取器（yauzl 动态 import），供 PPTX/XLSX/EPUB 预检与读取使用
// ---------------------------------------------------------------------------

export interface ZipEntry {
  name: string;
  size: number;
  readUtf8(): string;
  readBytes(): Uint8Array;
}

export interface ZipReadOptions {
  maxEntries?: number;
  maxEntryBytes?: number;
}

const DEFAULT_MAX_ENTRIES = 5000;
const DEFAULT_MAX_ENTRY_BYTES = 64 * 1024 * 1024;

export class ZipLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipLimitError';
  }
}

interface YauzlEntry {
  fileName: string;
  uncompressedSize: number;
}

interface YauzlZipFile {
  readEntry(): void;
  openReadStream(
    entry: YauzlEntry,
    callback: (error: Error | null, stream?: NodeJS.ReadableStream) => void,
  ): void;
  close(): void;
  on(event: 'entry', listener: (entry: YauzlEntry) => void): this;
  on(event: 'end', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

interface YauzlModule {
  fromBuffer(
    buffer: Buffer,
    options: { lazyEntries: boolean },
    callback: (error: Error | null, zipfile?: YauzlZipFile) => void,
  ): void;
}

const load = createRequire(import.meta.url);

export async function openZipEntries(
  bytes: Uint8Array,
  options: ZipReadOptions = {},
): Promise<ZipEntry[]> {
  const yauzl = load('yauzl') as unknown as YauzlModule;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
  const buffer = Buffer.from(bytes);
  const zip = await new Promise<YauzlZipFile>((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, file) => {
      if (error || !file) reject(error ?? new Error('zip_open_failed'));
      else resolve(file);
    });
  });

  const entries: ZipEntry[] = [];
  await new Promise<void>((resolve, reject) => {
    zip.on('error', reject);
    zip.on('entry', (entry) => {
      if (entries.length >= maxEntries) {
        reject(new ZipLimitError(`zip entries exceed ${maxEntries}`));
        zip.close();
        return;
      }
      if (entry.uncompressedSize > maxEntryBytes) {
        reject(new ZipLimitError(`zip entry ${entry.fileName} exceeds ${maxEntryBytes} bytes`));
        zip.close();
        return;
      }
      const name = entry.fileName;
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
          reject(error ?? new Error('zip_entry_open_failed'));
          return;
        }
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('error', reject);
        stream.on('end', () => {
          const data = Buffer.concat(chunks);
          entries.push({
            name,
            size: entry.uncompressedSize,
            readUtf8: () => data.toString('utf8'),
            readBytes: () => new Uint8Array(data),
          });
          zip.readEntry();
        });
      });
    });
    zip.on('end', resolve);
    zip.readEntry();
  });
  zip.close();
  return entries;
}
