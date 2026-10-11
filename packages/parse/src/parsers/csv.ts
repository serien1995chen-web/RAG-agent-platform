/**
 * @kb/parse CSV 解析（设计 9.8.1）：PapaParse 转 Markdown；表头缺失或重复返回 501058。
 */
import Papa from "papaparse";
import type { ParseHandler } from "../format-registry";
import { parseError, parseFailedError } from "../format-registry";
import { decodeText, makeResult, toMarkdownTable } from "./core";

export const parseCsv: ParseHandler = async (context) => {
  const requestId = context.request.fileRef;
  const text = decodeText(context.bytes);
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: "greedy" });
  const rows = parsed.data as string[][];
  if (parsed.errors.length > 0) {
    throw parseFailedError("csv", parsed.errors[0]?.code ?? "csv_parse_failed", requestId);
  }
  const header = (rows[0] ?? []).map((cell) => normalizeHeader(cell));
  const missingHeaders: string[] = [];
  for (const required of ["q", "a"]) if (!header.includes(required)) missingHeaders.push(required);
  const seen = new Set<string>();
  const duplicateHeaders: string[] = [];
  for (const name of header) {
    if (name.length === 0) continue;
    if (seen.has(name)) duplicateHeaders.push(name);
    else seen.add(name);
  }
  if (missingHeaders.length > 0 || duplicateHeaders.length > 0) {
    throw parseError(501058, requestId, { missingHeaders, duplicateHeaders });
  }
  const body = rows.slice(1).map((row) => header.map((_name, index) => String(row[index] ?? "")));
  return makeResult("csv", toMarkdownTable(header, body));
};

function normalizeHeader(value: string): string {
  return value.replace(/^\ufeff/, "").trim().toLowerCase();
}
