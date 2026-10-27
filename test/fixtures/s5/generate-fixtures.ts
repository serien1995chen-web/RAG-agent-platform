import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { deflateRawSync, crc32 } from 'node:zlib';

interface ZipFile {
  name: string;
  data: Buffer;
  method?: 0 | 8;
  compressedSize?: number;
  uncompressedSize?: number;
  flags?: number;
}

const requireFromParse = createRequire(
  new URL('../../../packages/parse/package.json', import.meta.url),
);

export function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function buildZip(files: readonly ZipFile[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const nameBytes = Buffer.from(file.name, 'utf8');
    const method = file.method ?? 8;
    const compressed = method === 8 ? deflateRawSync(file.data) : file.data;
    const compressedSize = file.compressedSize ?? compressed.length;
    const uncompressedSize = file.uncompressedSize ?? file.data.length;
    const data = Buffer.alloc(compressedSize);
    compressed.copy(data);
    const checksum = crc32(file.data);
    const flags = file.flags ?? 0x0800;
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt32LE(checksum >>> 0, 14);
    localHeader.writeUInt32LE(compressedSize, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localParts.push(localHeader, nameBytes, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt32LE(checksum >>> 0, 16);
    centralHeader.writeUInt32LE(compressedSize, 20);
    centralHeader.writeUInt32LE(uncompressedSize, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + data.length;
  }
  const local = Buffer.concat(localParts);
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

export function pdfWithText(text = 'Hello S5 PDF'): Buffer {
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
  for (const objectOffset of offsets) {
    body += `${objectOffset.toString().padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(body, 'latin1');
}

export function damagedPdf(): Buffer {
  return Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog');
}

export function docxBytes(text = 'S5 document'): Buffer {
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const documentXml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;
  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes) },
    { name: 'word/document.xml', data: Buffer.from(documentXml) },
  ]);
}

export function pptxBytes(): Buffer {
  const slide = `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>S5 slide</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  return buildZip([{ name: 'ppt/slides/slide1.xml', data: Buffer.from(slide) }]);
}

export function xlsxBytes(): Buffer {
  const XLSX = requireFromParse('xlsx') as {
    utils: {
      book_new(): unknown;
      aoa_to_sheet(rows: string[][]): unknown;
      book_append_sheet(workbook: unknown, sheet: unknown, name: string): void;
    };
    write(input: unknown, options: { type: 'buffer'; bookType: 'xlsx' }): Buffer;
  };
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ['q', 'a'],
    ['S5 question', 'S5 answer'],
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, 'QA');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

export function epubBytes(): Buffer {
  const container = `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
  const opf = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest><item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`;
  const chapter = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>S5</title></head><body><h1>S5 ebook</h1><p>chapter</p></body></html>`;
  return buildZip([
    { name: 'mimetype', data: Buffer.from('application/epub+zip'), method: 0 },
    { name: 'META-INF/container.xml', data: Buffer.from(container) },
    { name: 'OEBPS/content.opf', data: Buffer.from(opf) },
    { name: 'OEBPS/chapter1.xhtml', data: Buffer.from(chapter) },
  ]);
}

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=',
  'base64',
);

export function ofdBytes(): Buffer {
  const ofd = `<?xml version="1.0" encoding="UTF-8"?><ofd:OFD xmlns:ofd="http://www.ofdspec.org/2016" DocType="OFD" Version="1.0"><ofd:DocBody><ofd:DocInfo><ofd:DocID>s5</ofd:DocID></ofd:DocInfo><ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot></ofd:DocBody></ofd:OFD>`;
  const page1 = `<?xml version="1.0" encoding="UTF-8"?><ofd:Page xmlns:ofd="http://www.ofdspec.org/2016"><ofd:Content><ofd:Layer><ofd:TextObject><ofd:TextCode>OFD page one</ofd:TextCode></ofd:TextObject></ofd:Layer></ofd:Content></ofd:Page>`;
  const page2 = `<?xml version="1.0" encoding="UTF-8"?><ofd:Page xmlns:ofd="http://www.ofdspec.org/2016"><ofd:Content><ofd:Layer><ofd:TextObject><ofd:TextCode>OFD page two</ofd:TextCode></ofd:TextObject></ofd:Layer></ofd:Content></ofd:Page>`;
  return buildZip([
    { name: 'OFD.xml', data: Buffer.from(ofd) },
    { name: 'Doc_0/Document.xml', data: Buffer.from('<ofd:Document/>') },
    { name: 'Doc_0/Pages/Page_0/Content.xml', data: Buffer.from(page1) },
    { name: 'Doc_0/Pages/Page_1/Content.xml', data: Buffer.from(page2) },
    { name: 'Doc_0/Res/Page_0/image.png', data: PNG_1X1, method: 0 },
  ]);
}

export function hostileZip(): Buffer {
  return buildZip([{ name: '../escape.txt', data: Buffer.from('unsafe') }]);
}

export const S5_FIXTURES = {
  text: 'S5 text fixture',
  markdown: '# S5 Markdown\n\nbody',
  html: '<html><body><h1>S5 HTML</h1></body></html>',
  csv: 'q,a\nquestion,answer\n',
  pdf: pdfWithText(),
  docx: docxBytes(),
  pptx: pptxBytes(),
  xlsx: xlsxBytes(),
  epub: epubBytes(),
  ofd: ofdBytes(),
  hostileZip: hostileZip(),
} as const;

export function fixtureHashes(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(S5_FIXTURES).map(([name, value]) => [
      name,
      sha256(typeof value === 'string' ? value : value),
    ]),
  );
}
