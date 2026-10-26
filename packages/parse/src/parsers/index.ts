/**
 * @kb/parse 解析器注册与分派（设计 9.8.1）。
 * 分派键与 PARSE_FORMAT_MATRIX 一致；未登记格式返回 KNOWLEDGE_UNSUPPORTED_CONTENT。
 */
import type { ParseFormat, ParseFormatRegistry } from '../format-registry';
import { ParseFormatRegistry as Registry } from '../format-registry';
import { parseCsv } from './csv';
import { parseDocx } from './docx';
import { parseEbook } from './ebook';
import { parseHtml } from './html';
import { parseMarkdown } from './markdown';
import { parsePdf } from './pdf';
import { parsePptx } from './pptx';
import { parseText } from './text';
import { parseXlsx } from './xlsx';
import { parseOfd } from '../s5/ofd-parser';
import { parsePdfWithLiteParse } from '../s5/liteparse-provider';

/** 建立包含全部 9 类格式的注册表；缺失任一矩阵项会在注册期抛错。 */
export function createParserRegistry(): ParseFormatRegistry {
  const registry = new Registry();
  const handlers: Record<ParseFormat, Parameters<ParseFormatRegistry['register']>[1]> = {
    text: parseText,
    markdown: parseMarkdown,
    html: parseHtml,
    pdf: parsePdfWithLiteParse,
    docx: parseDocx,
    pptx: parsePptx,
    xlsx: parseXlsx,
    csv: parseCsv,
    ebook: parseEbook,
    ofd: parseOfd,
  };
  for (const format of Object.keys(handlers) as ParseFormat[]) {
    registry.register(format, handlers[format]);
  }
  return registry;
}

export {
  parseCsv,
  parseDocx,
  parseEbook,
  parseHtml,
  parseMarkdown,
  parsePdf,
  parseOfd,
  parsePptx,
  parseText,
  parseXlsx,
};
