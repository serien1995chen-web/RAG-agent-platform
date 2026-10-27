import { createHash } from 'node:crypto';
import {
  makeResult,
  normalizeRawText,
  openZipEntries,
  parseError,
  parseFailedError,
  type ParseAsset,
  type ParseHandler,
  type ParsePage,
} from '../format-registry';
import { inspectArchiveBuffer, validateArchiveEntryPath } from '../archive-safety';

const PAGE_FILE_RE = /(?:^|\/)Pages\/Page_(\d+)\/Content\.xml$/i;
const PAGE_NUMBER_RE = /Page_(\d+)/i;
const TEXT_RE = /<ofd:TextCode\b[^>]*>([\s\S]*?)<\/ofd:TextCode>/gi;
const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i;

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\x27')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 10)),
    );
}

function textOf(xml: string): string {
  const parts: string[] = [];
  let match: RegExpExecArray | null;
  TEXT_RE.lastIndex = 0;
  while ((match = TEXT_RE.exec(xml)) !== null) {
    const text = decodeXml(match[1] ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) parts.push(text);
  }
  return parts.join(' ');
}

function pageNumberFor(path: string): number {
  const value = Number.parseInt(
    PAGE_FILE_RE.exec(path)?.[1] ?? PAGE_NUMBER_RE.exec(path)?.[1] ?? '0',
    10,
  );
  return value + 1;
}

export const parseOfd: ParseHandler = async (context) => {
  const requestId = context.request.fileRef;
  const safety = await inspectArchiveBuffer(context.bytes, {
    originalName: context.request.fileRef,
    container: 'zip',
  });
  if (!safety.safe) {
    throw parseError('KNOWLEDGE_UNSUPPORTED_CONTENT', requestId, {
      format: 'ofd',
      reason: safety.reason ?? safety.status,
    });
  }
  let entries;
  try {
    entries = await openZipEntries(context.bytes, {
      maxEntries: 5_000,
      maxEntryBytes: 64 * 1024 * 1024,
    });
  } catch {
    throw parseFailedError('ofd', 'ofd_archive_open_failed', requestId);
  }
  for (const entry of entries) {
    if (validateArchiveEntryPath(entry.name) !== null) {
      throw parseError('KNOWLEDGE_UNSUPPORTED_CONTENT', requestId, {
        format: 'ofd',
        reason: 'entry_path_invalid',
      });
    }
  }
  if (!entries.some((entry) => entry.name === 'OFD.xml' || entry.name.endsWith('/OFD.xml'))) {
    throw parseError('KNOWLEDGE_UNSUPPORTED_CONTENT', requestId, {
      format: 'ofd',
      reason: 'ofd_marker_missing',
    });
  }
  const pageTexts = new Map<number, string[]>();
  const assetsByPage = new Map<number, ParseAsset[]>();
  for (const entry of entries) {
    if (PAGE_FILE_RE.test(entry.name)) {
      const number = pageNumberFor(entry.name);
      const text = textOf(entry.readUtf8());
      pageTexts.set(number, [...(pageTexts.get(number) ?? []), text].filter(Boolean));
      continue;
    }
    if (IMAGE_RE.test(entry.name)) {
      const bytes = entry.readBytes();
      const extension = entry.name.split('.').at(-1)?.toLowerCase() ?? '';
      const number = pageNumberFor(entry.name);
      const asset: ParseAsset = {
        assetId: createHash('sha256').update(entry.name).digest('hex').slice(0, 32),
        mimeType: MIME_BY_EXTENSION[extension] ?? 'application/octet-stream',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: bytes.byteLength,
        bytes,
      };
      assetsByPage.set(number, [...(assetsByPage.get(number) ?? []), asset]);
    }
  }
  const pageNumbers = [...new Set([...pageTexts.keys(), ...assetsByPage.keys()])].sort(
    (left, right) => left - right,
  );
  if (pageNumbers.length === 0) {
    throw parseError('KNOWLEDGE_UNSUPPORTED_CONTENT', requestId, {
      format: 'ofd',
      reason: 'ofd_pages_missing',
    });
  }
  const pages: ParsePage[] = pageNumbers.map((number) => ({
    pageNumber: number,
    text: pageTexts.get(number)?.join(' ') ?? '',
    assets: assetsByPage.get(number) ?? [],
  }));
  const assets = pages.flatMap((page) => page.assets);
  const rawText = normalizeRawText(
    pages
      .filter((page) => page.text.length > 0)
      .map((page) => `## Page ${page.pageNumber}\n\n${page.text}`)
      .join('\n\n'),
  );
  if (rawText.replace(/\s/g, '').length === 0) {
    throw parseError('KNOWLEDGE_UNSUPPORTED_CONTENT', requestId, {
      format: 'ofd',
      reason: 'ofd_text_empty',
    });
  }
  return makeResult('ofd', rawText, {
    pages,
    assets,
    parserVersion: 'ofd-clean-room@1',
  });
};
