/**
 * @kb/parse 纯文本解析器：编码探测（BOM → charset → 统计 → UTF-8）+ 非法字节替换（设计 9.8.1）。
 */
import type { ParseHandler } from "../format-registry";
import { decodeText, detectEncoding, makeResult, normalizeRawText } from "./core";

export const parseText: ParseHandler = async (context) => {
  const encoding = detectEncoding(context.bytes);
  const text = normalizeRawText(decodeText(context.bytes, encoding));
  return makeResult("text", text);
};
