import { deflateRawSync } from 'node:zlib';
import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { createDefaultDocumentParser, type DocumentParseContext } from '../../src/index';
import { unsupportedFormatError } from '../../src/format-registry';

// ---- minimal ZIP writer (stored/deflated) for binary fixtures ----
interface ZipFile {
  name: string;
  data: Buffer;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(files: ZipFile[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const nameBytes = Buffer.from(file.name, 'utf8');
    const compressed = deflateRawSync(file.data);
    const crc = crc32(file.data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(file.data.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localParts.push(localHeader, nameBytes, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(file.data.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + compressed.length;
  }
  const central = Buffer.concat(centralParts);
  const local = Buffer.concat(localParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

function pdfWithText(text: string): Buffer {
  const content = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(body, 'latin1');
}

function pdfWithoutText(): Buffer {
  const content = '0 0 0 rg 10 10 100 100 re f';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(body, 'latin1');
}

function docxBytes(text: string): Buffer {
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const documentXml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;
  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes) },
    { name: 'word/document.xml', data: Buffer.from(documentXml) },
  ]);
}

function pptxBytes(slideText: string, notes: string): Buffer {
  const slide = `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${slideText}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  const notesXml = `<?xml version="1.0" encoding="UTF-8"?><p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${notes}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`;
  return buildZip([
    { name: 'ppt/slides/slide1.xml', data: Buffer.from(slide) },
    { name: 'ppt/notesSlides/notesSlide1.xml', data: Buffer.from(notesXml) },
  ]);
}

function epubBytes(title: string, body: string): Buffer {
  const container = `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
  const opf = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest><item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`;
  const chapter = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body><h1>${title}</h1><p>${body}</p></body></html>`;
  return buildZip([
    { name: 'META-INF/container.xml', data: Buffer.from(container) },
    { name: 'OEBPS/content.opf', data: Buffer.from(opf) },
    { name: 'OEBPS/chapter1.xhtml', data: Buffer.from(chapter) },
  ]);
}

function xlsxBytes(): Buffer {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ['q', 'a'],
    ['问题1', '答案1'],
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, 'QA');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

function request(
  extension: string,
  extra: Partial<DocumentParseContext> = {},
): DocumentParseContext {
  return {
    teamId: 'team-1',
    datasetId: 'ds-1',
    fileRef: `fixture.${extension}`,
    extension,
    timeoutMs: 30000,
    ...extra,
  };
}

const parser = createDefaultDocumentParser();

describe('TEST-PARSE-FORMAT-001 nine-format parsing matrix', () => {
  it('parses txt with encoding detection', async () => {
    const result = await parser.parse(request('txt', { bytes: Buffer.from('hello 世界', 'utf8') }));
    expect(result.format).toBe('text');
    expect(result.rawText).toBe('hello 世界');
    expect(result.scanRequired).toBe(false);
  });

  it('parses markdown preserving headings', async () => {
    const markdown = '# 标题\n\n正文 | 表格';
    const result = await parser.parse(request('md', { bytes: Buffer.from(markdown) }));
    expect(result.format).toBe('markdown');
    expect(result.rawText).toContain('# 标题');
  });

  it('converts html to markdown and drops scripts', async () => {
    const html = `<!doctype html><html><head><title>Doc</title></head><body><script>bad()</script><h1>标题</h1><p>段落</p><table><tr><th>A</th></tr><tr><td>1</td></tr></table></body></html>`;
    const result = await parser.parse(request('html', { bytes: Buffer.from(html) }));
    expect(result.format).toBe('html');
    expect(result.rawText).not.toContain('bad()');
    expect(result.rawText).toContain('标题');
    expect(result.rawText).toMatch(/\|\s+A\s+\|/);
  });

  it('parses csv into a markdown table', async () => {
    const result = await parser.parse(request('csv', { bytes: Buffer.from('q,a\n问题,答案\n') }));
    expect(result.format).toBe('csv');
    expect(result.rawText).toContain('| q | a |');
    expect(result.rawText).toContain('| 问题 | 答案 |');
  });

  it('rejects csv with invalid headers as 501058', async () => {
    const error = await parser
      .parse(request('csv', { bytes: Buffer.from('question,answer\n1,2\n') }))
      .catch((thrown: unknown) => thrown);
    expect((error as { error: { code: number } }).error.code).toBe(501058);
  });

  it('parses xlsx into sheet-scoped markdown', async () => {
    const result = await parser.parse(request('xlsx', { bytes: xlsxBytes() }));
    expect(result.format).toBe('xlsx');
    expect(result.rawText).toContain('## QA');
    expect(result.rawText).toContain('| q | a |');
  });

  it('parses docx text into markdown', async () => {
    const result = await parser.parse(request('docx', { bytes: docxBytes('合同正文') }));
    expect(result.format).toBe('docx');
    expect(result.rawText).toContain('合同正文');
  });

  it('parses pptx slides with notes merged', async () => {
    const result = await parser.parse(request('pptx', { bytes: pptxBytes('要点一', '演讲备注') }));
    expect(result.format).toBe('pptx');
    expect(result.rawText).toContain('## Slide 1');
    expect(result.rawText).toContain('要点一');
    expect(result.rawText).toContain('演讲备注');
  });

  it('parses epub chapters by spine order', async () => {
    const result = await parser.parse(request('epub', { bytes: epubBytes('第一章', '章节正文') }));
    expect(result.format).toBe('ebook');
    expect(result.rawText).toContain('第一章');
    expect(result.rawText).toContain('章节正文');
  });

  it('parses a PDF text layer', async () => {
    const result = await parser.parse(request('pdf', { bytes: pdfWithText('Hello PDF') }));
    expect(result.format).toBe('pdf');
    expect(result.rawText).toContain('Hello PDF');
    expect(result.scanRequired).toBe(false);
  });

  it('marks a text-less PDF as scanRequired', async () => {
    const result = await parser.parse(request('pdf', { bytes: pdfWithoutText() }));
    expect(result.format).toBe('pdf');
    expect(result.scanRequired).toBe(true);
  });

  it('rejects a damaged file as 501057', async () => {
    const error = await parser
      .parse(request('docx', { bytes: Buffer.from('not a zip') }))
      .catch((thrown: unknown) => thrown);
    expect((error as { error: { code: number } }).error.code).toBe(501057);
  });

  it('rejects an unregistered format as 501056', async () => {
    const error = await parser
      .parse(request('rtf', { bytes: Buffer.from('{\\rtf1}') }))
      .catch((thrown: unknown) => thrown);
    expect((error as { error: { code: number } }).error.code).toBe(501056);
    expect(unsupportedFormatError('rtf', 'x').error.code).toBe(501056);
  });

  it('is deterministic: same input yields the same content hash', async () => {
    const bytes = Buffer.from('stable content');
    const first = await parser.parse(request('txt', { bytes }));
    const second = await parser.parse(request('txt', { bytes }));
    expect(first.contentHash).toBe(second.contentHash);
  });
});
