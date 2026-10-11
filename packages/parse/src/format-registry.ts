/**
 * @kb/parse 格式注册表（设计文档 9.8.1）。
 * 以 PARSE_FORMAT_MATRIX 为唯一权威，建立「扩展名/MIME → 解析器实现」映射；
 * 未登记格式返回 501056，解析失败返回 501057，不得静默降级为纯文本。
 */
import { ApiErrorException, createApiError } from "@kb/contracts";
import {
  PARSE_FORMAT_MATRIX,
  resolveParseFormat,
  type ParseFormatSpec,
  type ParseRequest,
  type ParseResult,
} from "./types";

export type ParseFormat = "text" | "markdown" | "html" | "pdf" | "docx" | "pptx" | "xlsx" | "csv" | "ebook";

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
  text: ["text/plain"],
  markdown: ["text/markdown", "text/x-markdown"],
  html: ["text/html", "application/xhtml+xml"],
  pdf: ["application/pdf"],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  pptx: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  csv: ["text/csv", "application/csv"],
  ebook: ["application/epub+zip"],
};

/** 归一化扩展名：去前导点、小写。 */
export function normalizeExtension(extension: string): string {
  return extension.replace(/^\./, "").trim().toLowerCase();
}

/** 归一化 MIME：去 parameters（; charset=...）并小写。 */
export function normalizeMimeType(mimeType: string | undefined): string | undefined {
  if (!mimeType) return undefined;
  const base = mimeType.split(";")[0];
  return base ? base.trim().toLowerCase() : undefined;
}

export function parseError(
  code: number,
  requestId: string,
  params: Record<string, unknown> = {},
): ApiErrorException {
  return new ApiErrorException(createApiError({ code, requestId, params }));
}

export function unsupportedFormatError(extension: string, requestId: string): ApiErrorException {
  return parseError(501056, requestId, { extension: normalizeExtension(extension) || extension });
}

export function parseFailedError(extension: string, reason: string, requestId: string): ApiErrorException {
  return parseError(501057, requestId, { extension: normalizeExtension(extension), reason });
}

/** 注册表：以 format 为键，每个矩阵项必须恰好注册一个 handler。 */
export class ParseFormatRegistry {
  private readonly byFormat = new Map<ParseFormat, ParseFormatRegistration>();
  private readonly byExtension = new Map<string, ParseFormat>();
  private readonly byMime = new Map<string, ParseFormat>();

  register(format: ParseFormat, handler: ParseHandler): void {
    const spec = PARSE_FORMAT_MATRIX.find((item) => item.format === format);
    if (!spec) {
      throw parseError(501056, format, { extension: format, reason: "format_not_in_matrix" });
    }
    if (this.byFormat.has(format)) {
      throw parseError(501056, format, { extension: format, reason: "format_already_registered" });
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

export { PARSE_FORMAT_MATRIX, resolveParseFormat };
