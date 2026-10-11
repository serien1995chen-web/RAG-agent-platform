/**
 * @kb/parse 冻结类型与 9 类格式矩阵（设计文档 9.8.1）。
 * index.ts 与各子模块共用，避免 barrel 循环依赖。
 */
import { createHash } from "node:crypto";

export interface ParseFormatSpec {
  format: string;
  extensions: readonly string[];
  parser: string;
  fallback: string;
}

/** 设计文档 9.8.1 冻结的 9 类格式矩阵。 */
export const PARSE_FORMAT_MATRIX: readonly ParseFormatSpec[] = [
  { format: "text", extensions: ["txt"], parser: "native-text", fallback: "rawText" },
  {
    format: "markdown",
    extensions: ["md", "markdown"],
    parser: "native-markdown",
    fallback: "rawText",
  },
  {
    format: "html",
    extensions: ["html", "htm"],
    parser: "html-to-markdown",
    fallback: "plain-text",
  },
  {
    format: "pdf",
    extensions: ["pdf"],
    parser: "pdf-text-layer",
    fallback: "pdf-enhance-provider",
  },
  { format: "docx", extensions: ["docx"], parser: "docx-parser", fallback: "none" },
  { format: "pptx", extensions: ["pptx"], parser: "pptx-parser", fallback: "none" },
  { format: "xlsx", extensions: ["xlsx"], parser: "xlsx-precheck", fallback: "none" },
  { format: "csv", extensions: ["csv"], parser: "csv-parser", fallback: "none" },
  { format: "ebook", extensions: ["epub"], parser: "document-parser-port", fallback: "none" },
];

export interface ParseRequest {
  teamId: string;
  datasetId: string;
  fileRef: string;
  extension: string;
  mimeType?: string;
  timeoutMs: number;
}

export interface ParseResult {
  format: string;
  rawText: string;
  scanRequired: boolean;
  imageRefs: string[];
  contentHash: string;
}

/** 扩展格式必须实现该 Port；未注册格式不得静默降级为普通文本。 */
export interface DocumentParserPort {
  parse(request: ParseRequest): Promise<ParseResult>;
}

export function resolveParseFormat(extension: string): ParseFormatSpec | null {
  const normalized = extension.replace(/^\./, "").toLowerCase();
  return (
    PARSE_FORMAT_MATRIX.find((spec) =>
      (spec.extensions as readonly string[]).includes(normalized),
    ) ?? null
  );
}

/** 稳定内容哈希：同一文本 → 同一 contentHash（用于 Chunk/QA 依赖）。 */
export function contentHashOf(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}
