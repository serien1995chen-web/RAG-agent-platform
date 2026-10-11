/**
 * @kb/parse 电子书（EPUB）解析（设计 9.8.1）：经 DocumentParserPort 自研扩展点实现，按段落。
 * 仅使用自研扩展点实现，不引入来源项目 SDK；不支持格式返回 501056。
 */
import {
  makeResult,
  normalizeRawText,
  openZipEntries,
  parseFailedError,
  type ParseHandler,
} from '../format-registry';
import { convertHtmlToMarkdown } from './html';

const CONTAINER_RE = /full-path\s*=\s*"([^"]+)"/i;
const ITEMREFS_RE = /<itemref\b[^>]*idref\s*=\s*"([^"]+)"/gi;
const ITEM_RE = /<item\b[^>]*>/gi;
const ATTR_RE = (name: string): RegExp => new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i');

function resolvePath(base: string, relative: string): string {
  const baseParts = base.split('/').slice(0, -1);
  const parts = relative.split('/');
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') baseParts.pop();
    else baseParts.push(part);
  }
  return baseParts.join('/');
}

export const parseEbook: ParseHandler = async (context) => {
  const requestId = context.request.fileRef;
  try {
    const entries = await openZipEntries(context.bytes);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    const container = byName.get('META-INF/container.xml');
    if (!container) throw parseFailedError('ebook', 'missing_container', requestId);
    const opfPath = CONTAINER_RE.exec(container.readUtf8())?.[1];
    if (!opfPath) throw parseFailedError('ebook', 'missing_opf_path', requestId);
    const opf = byName.get(opfPath);
    if (!opf) throw parseFailedError('ebook', 'missing_opf', requestId);
    const opfXml = opf.readUtf8();

    const idToHref = new Map<string, string>();
    ITEM_RE.lastIndex = 0;
    let itemMatch: RegExpExecArray | null;
    while ((itemMatch = ITEM_RE.exec(opfXml)) !== null) {
      const tag = itemMatch[0];
      const id = ATTR_RE('id').exec(tag)?.[1];
      const href = ATTR_RE('href').exec(tag)?.[1];
      if (id && href) idToHref.set(id, href);
    }

    const spineHrefs: string[] = [];
    ITEMREFS_RE.lastIndex = 0;
    let refMatch: RegExpExecArray | null;
    while ((refMatch = ITEMREFS_RE.exec(opfXml)) !== null) {
      const idref = refMatch[1];
      if (!idref) continue;
      const href = idToHref.get(idref);
      if (href) spineHrefs.push(resolvePath(opfPath, href));
    }

    const sections: string[] = [];
    for (const href of spineHrefs) {
      const entry = byName.get(href);
      if (!entry) continue;
      const markdown = (await convertHtmlToMarkdown(entry.readUtf8())).trim();
      if (markdown.length > 0) sections.push(markdown);
    }
    if (sections.length === 0) {
      for (const entry of entries) {
        if (!/\.x?html?$/i.test(entry.name)) continue;
        const markdown = (await convertHtmlToMarkdown(entry.readUtf8())).trim();
        if (markdown.length > 0) sections.push(markdown);
      }
    }
    return makeResult('ebook', normalizeRawText(sections.join('\n\n')));
  } catch (error) {
    if (error instanceof Error && error.name === 'ApiErrorException') throw error;
    throw parseFailedError('ebook', 'ebook_parse_failed', requestId);
  }
};
