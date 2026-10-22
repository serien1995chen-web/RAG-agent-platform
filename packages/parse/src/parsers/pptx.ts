/**
 * PPTX 解析：每页一段，备注并入正文；失败返回稳定业务错误。
 * 以最小 zip/XML 读取实现（不引入未登记依赖），避免与来源项目 anydoc 关联。
 */
import {
  makeResult,
  normalizeRawText,
  openZipEntries,
  parseFailedError,
  type ParseHandler,
} from '../format-registry';

const XML_TEXT_RE = /<a:t>([\s\S]*?)<\/a:t>/g;
const SLIDE_RE = /^ppt\/slides\/slide(\d+)\.xml$/;
const NOTES_RE = /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/;
const IMAGE_RE = /^ppt\/media\/[^/]+$/;

function xmlToText(xml: string): string {
  const parts: string[] = [];
  let match: RegExpExecArray | null;
  XML_TEXT_RE.lastIndex = 0;
  while ((match = XML_TEXT_RE.exec(xml)) !== null) {
    if (match[1]) parts.push(decodeXmlEntities(match[1]));
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\x27')
    .replace(/&amp;/g, '&');
}

function indexOf(match: RegExpExecArray | null): number {
  if (!match || !match[1]) return 0;
  return Number.parseInt(match[1], 10) || 0;
}

export const parsePptx: ParseHandler = async (context) => {
  const requestId = context.request.fileRef;
  try {
    const entries = await openZipEntries(context.bytes);
    const slideText = new Map<number, string>();
    const notesText = new Map<number, string>();
    const imageRefs: string[] = [];
    for (const entry of entries) {
      const name = entry.name;
      if (SLIDE_RE.test(name)) {
        slideText.set(indexOf(SLIDE_RE.exec(name)), xmlToText(entry.readUtf8()));
      } else if (NOTES_RE.test(name)) {
        notesText.set(indexOf(NOTES_RE.exec(name)), xmlToText(entry.readUtf8()));
      } else if (IMAGE_RE.test(name)) {
        imageRefs.push(name);
      }
    }
    if (slideText.size === 0) throw parseFailedError('pptx', 'no_slides', requestId);
    const slideNumbers = [...slideText.keys()].sort((a, b) => a - b);
    const sections = slideNumbers.map((number) => {
      const body = slideText.get(number) ?? '';
      const notes = notesText.get(number) ?? '';
      const hasNotes = notes.length > 0;
      return hasNotes
        ? `## Slide ${number}\n\n${body}\n\n备注：${notes}`
        : `## Slide ${number}\n\n${body}`;
    });
    return makeResult('pptx', normalizeRawText(sections.join('\n\n')), { imageRefs });
  } catch (error) {
    if (error instanceof Error && error.name === 'KnowledgeApiError') throw error;
    throw parseFailedError('pptx', 'pptx_parse_failed', requestId);
  }
};
