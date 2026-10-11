/**
 * @kb/parse Markdown 解析器：保留标题层级与表格（按段落保留）（设计 9.8.1）。
 */
import { decodeText, makeResult, normalizeRawText, type ParseHandler } from '../format-registry';

export const parseMarkdown: ParseHandler = async (context) => {
  const text = normalizeRawText(decodeText(context.bytes));
  return makeResult('markdown', text);
};
