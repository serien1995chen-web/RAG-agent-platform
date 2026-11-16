import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { buildZip, pdfWithText } from '../s5/generate-fixtures';

const requireFromParse = createRequire(
  new URL('../../../packages/parse/package.json', import.meta.url),
);

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function b11PdfWithText(): Buffer {
  return pdfWithText('B11 text layer document');
}

export function b11PdfWithoutText(): Buffer {
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

export function b11EncryptedPdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [] /Count 0 >>',
    '<< /Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -4 >>',
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
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Encrypt 3 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(body, 'latin1');
}

export function b11PptxWithNotes(): Buffer {
  const slide1 = `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>B11 slide body</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  const notes1 = `<?xml version="1.0" encoding="UTF-8"?><p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>B11 speaker notes</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`;
  const slide2 = slide1.replace('B11 slide body', 'B11 second slide');
  return buildZip([
    { name: 'ppt/slides/slide1.xml', data: Buffer.from(slide1) },
    { name: 'ppt/notesSlides/notesSlide1.xml', data: Buffer.from(notes1) },
    { name: 'ppt/slides/slide2.xml', data: Buffer.from(slide2) },
  ]);
}

export function b11XlsxTwoSheets(): Buffer {
  const XLSX = requireFromParse('xlsx') as {
    utils: {
      book_new(): unknown;
      aoa_to_sheet(rows: string[][]): unknown;
      book_append_sheet(workbook: unknown, sheet: unknown, name: string): void;
    };
    write(input: unknown, options: { type: 'buffer'; bookType: 'xlsx' }): Buffer;
  };
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ['name', 'value'],
      ['alpha', '1'],
    ]),
    'First',
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ['name', 'value'],
      ['beta', '2'],
    ]),
    'Second',
  );
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

export const B11_FIXTURE_CONTENT = {
  text: 'B11 TXT 正文',
  markdown: '# B11 Markdown\n\n| q | a |\n| --- | --- |\n| 问题 | 答案 |',
  html: '<html><head><title>B11 HTML</title></head><body><h1>B11 HTML</h1><script>bad()</script><table><tr><th>q</th><th>a</th></tr><tr><td>1</td><td>2</td></tr></table></body></html>',
  csv: 'q,a\nB11 question,B11 answer\n',
  ofdSecretMarker: 'B11 OFD',
} as const;
