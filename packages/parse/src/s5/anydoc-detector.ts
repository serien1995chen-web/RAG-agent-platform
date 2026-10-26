import { normalizeMimeType, openZipEntries, type ParseRequest } from '../format-registry';

const ANYDOC_MIMES = new Set([
  'application/x-anydoc',
  'application/anydoc',
  'application/vnd.anydoc',
]);

function isZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) &&
    (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08)
  );
}

function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length === 0 || bytes.includes(0)) return false;
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 8192));
  const replacements = [...decoded].filter((char) => char === '\ufffd').length;
  return decoded.length > 0 && replacements / decoded.length < 0.01;
}

export async function detectAnyDocExtension(
  input: Pick<ParseRequest, 'fileRef' | 'mimeType' | 'extension'>,
  bytes: Uint8Array,
): Promise<string | null> {
  const extension = input.extension.replace(/^\./, '').toLowerCase();
  const mime = normalizeMimeType(input.mimeType);
  const anyDoc =
    extension === 'anydoc' ||
    (extension.length === 0 && mime !== undefined && ANYDOC_MIMES.has(mime));
  if (!anyDoc) return null;
  if (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ) {
    return 'pdf';
  }
  if (isZip(bytes)) {
    const entries = await openZipEntries(bytes, { maxEntries: 5_000 });
    const names = new Set(entries.map((entry) => entry.name));
    if (names.has('word/document.xml')) return 'docx';
    if ([...names].some((name) => name.startsWith('ppt/slides/slide'))) return 'pptx';
    if (names.has('xl/workbook.xml')) return 'xlsx';
    if (names.has('OFD.xml') || [...names].some((name) => name.endsWith('/OFD.xml'))) {
      return 'ofd';
    }
    if (names.has('META-INF/container.xml')) return 'epub';
    return null;
  }
  if (looksLikeText(bytes)) return 'txt';
  return null;
}
