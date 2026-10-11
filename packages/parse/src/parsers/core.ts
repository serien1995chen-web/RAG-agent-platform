/**
 * @kb/parse 解析公共工具：编码探测、文本解码、Markdown 表格工具（设计文档 9.8.1）。
 */
import type { ParseResult } from "../types";
import { contentHashOf } from "../types";

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;
const UTF16LE_BOM = [0xff, 0xfe] as const;
const UTF16BE_BOM = [0xfe, 0xff] as const;

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, index) => bytes[index] === byte);
}

export type DetectedEncoding = "utf-8" | "utf-16le" | "utf-16be" | "gb18030";

const CHARSET_RE = /charset\s*=\s*[^a-z0-9]?\s*([a-z0-9_-]+)/i;

/** 编码探测优先级：BOM → charset 声明 → 统计探测 → UTF-8 兜底。 */
export function detectEncoding(bytes: Uint8Array): DetectedEncoding {
  if (startsWith(bytes, UTF8_BOM)) return "utf-8";
  if (startsWith(bytes, UTF16LE_BOM)) return "utf-16le";
  if (startsWith(bytes, UTF16BE_BOM)) return "utf-16be";

  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 4096)).toLowerCase();
  const declared = CHARSET_RE.exec(head)?.[1];
  if (declared) {
    if (declared === "utf-8" || declared === "utf8") return "utf-8";
    if (declared === "gbk" || declared === "gb2312" || declared === "gb18030") return "gb18030";
    if (declared === "utf-16" || declared === "utf-16le") return "utf-16le";
    if (declared === "utf-16be") return "utf-16be";
  }

  const sample = bytes.subarray(0, 8192);
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(sample);
  let replacement = 0;
  for (const char of decoded) if (char === "\ufffd") replacement += 1;
  if (decoded.length > 0 && replacement / decoded.length > 0.01) return "gb18030";
  return "utf-8";
}

/** 解码文本：非法字节以 U+FFFD 替换（告警由调用方记录），并去 BOM。 */
export function decodeText(bytes: Uint8Array, encoding: DetectedEncoding = detectEncoding(bytes)): string {
  let text = new TextDecoder(encoding, { fatal: false }).decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** 归一化换行与零宽字符；折叠 3+ 连续换行。 */
export function normalizeRawText(text: string): string {
  return normalizeNewlines(text)
    .replace(/\u200b|\u200c|\u200d|\u2060|\ufeff/g, "")
    .replace(/\n{3,}/g, "\n\n");
}

export function makeResult(
  format: string,
  rawText: string,
  options: { scanRequired?: boolean; imageRefs?: string[] } = {},
): ParseResult {
  return {
    format,
    rawText,
    scanRequired: options.scanRequired ?? false,
    imageRefs: options.imageRefs ?? [],
    contentHash: contentHashOf(rawText),
  };
}

/** Markdown 表格转义：单元格内换行/竖线归一化。 */
export function mdCell(value: string): string {
  return normalizeNewlines(value).replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

export function toMarkdownTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const header = `| ${headers.map(mdCell).join(" | ")} |`;
  const divider = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.map(mdCell).join(" | ")} |`);
  return [header, divider, ...body].join("\n");
}
