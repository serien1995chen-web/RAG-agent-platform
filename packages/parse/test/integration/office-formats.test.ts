import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import * as XLSX from 'xlsx';
import { createDefaultDocumentParser } from '../../src/index';
import {
  buildZip,
  docxBytes,
  pptxBytes,
  xlsxBytes,
} from '../../../../test/fixtures/s5/generate-fixtures';

const parser = createDefaultDocumentParser();
const marker = 'KB OFFICE FORMAT ACCEPTANCE';
const legacyFixtureRoot = join(import.meta.dirname, '../../../../test/fixtures/s5/legacy');

function legacyFixture(name: string): Buffer {
  const encoded = readFileSync(join(legacyFixtureRoot, `${name}.gz.b64`), 'utf8').trim();
  return gunzipSync(Buffer.from(encoded, 'base64'));
}

function request(extension: string, bytes: Uint8Array) {
  return {
    workspaceId: 'ws_parse_formats',
    knowledgeSpaceId: '6b06e97bcbe61f2b0c7a2097',
    sourceId: '6f06e97bcbe61f2b0c7a2097',
    fileRef: `office.${extension}`,
    extension,
    timeoutMs: 30_000,
    requestId: `office-${extension}`,
    traceId: `office-${extension}`,
    bytes,
  };
}

function openDocument(
  mimeType: string,
  body: string,
  namespace: 'text' | 'spreadsheet' | 'presentation',
) {
  return buildZip([
    { name: 'mimetype', data: Buffer.from(mimeType), method: 0 },
    {
      name: 'META-INF/manifest.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="${mimeType}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>`,
      ),
    },
    {
      name: 'content.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"><office:body><office:${namespace}>${body}</office:${namespace}></office:body></office:document-content>`,
      ),
    },
  ]);
}

describe('FastGPT-compatible Office format parsing', () => {
  it('parses OOXML macro, slideshow and WPS aliases through the shared parser', async () => {
    const docx = docxBytes(marker);
    const pptx = pptxBytes();
    const xlsx = xlsxBytes();
    const xlsWorkbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      xlsWorkbook,
      XLSX.utils.aoa_to_sheet([
        ['marker', marker],
        ['type', 'legacy-xls'],
      ]),
      'KB',
    );
    const xls = XLSX.write(xlsWorkbook, { type: 'buffer', bookType: 'biff8' }) as Buffer;
    const doc = legacyFixture('apache-poi-page-break-before.doc');
    const ppt = legacyFixture('apache-poi-legacy.ppt');
    const cases: Array<[string, Uint8Array]> = [
      ['docx', docx],
      ['docm', docx],
      ['pptx', pptx],
      ['pptm', pptx],
      ['ppsx', pptx],
      ['ppsm', pptx],
      ['xlsx', xlsx],
      ['xlsm', xlsx],
      ['xlsb', xlsx],
      ['xls', xls],
      ['doc', doc],
      ['wps', doc],
      ['ppt', ppt],
      ['pps', ppt],
      ['pot', ppt],
    ];
    const canonicalFormat: Record<string, string> = {
      docm: 'docx',
      pptm: 'pptx',
      ppsx: 'pptx',
      ppsm: 'pptx',
      xlsm: 'xlsx',
      xlsb: 'xlsx',
    };
    for (const [extension, bytes] of cases) {
      const parsed = await parser.parse(request(extension, bytes)).catch((error) => {
        throw new Error(`${extension}: ${error instanceof Error ? error.message : String(error)}`, {
          cause: error,
        });
      });
      expect(parsed.rawText.length, extension).toBeGreaterThan(0);
      expect(parsed.format, extension).toBe(canonicalFormat[extension] ?? extension);
      if (['doc', 'ppt', 'pps', 'pot', 'xls'].includes(extension)) {
        expect(parsed.parserVersion, extension).toMatch(/office-oxide-wasm@0\.1\.8/);
      }
    }
    const wpsAsOoxml = await parser.parse(request('wps', docx));
    expect(wpsAsOoxml.rawText).toContain(marker);
    expect(wpsAsOoxml.format).toBe('docx');
  }, 60_000);

  it('parses OpenDocument and RTF through the compatibility parser', async () => {
    const cases: Array<[string, Uint8Array]> = [
      [
        'odt',
        openDocument(
          'application/vnd.oasis.opendocument.text',
          `<text:p>${marker} Open document body</text:p>`,
          'text',
        ),
      ],
      [
        'odp',
        openDocument(
          'application/vnd.oasis.opendocument.presentation',
          `<draw:page><draw:frame><draw:text-box><text:p>${marker} Slides</text:p></draw:text-box></draw:frame></draw:page>`,
          'presentation',
        ),
      ],
      [
        'ods',
        openDocument(
          'application/vnd.oasis.opendocument.spreadsheet',
          `<table:table table:name="KB"><table:table-row><table:table-cell><text:p>${marker}</text:p></table:table-cell></table:table-row></table:table>`,
          'spreadsheet',
        ),
      ],
      ['rtf', Buffer.from(`{\\rtf1\\ansi ${marker} RTF body}`)],
    ];
    for (const [extension, bytes] of cases) {
      const parsed = await parser.parse(request(extension, bytes)).catch((error) => {
        throw new Error(`${extension}: ${error instanceof Error ? error.message : String(error)}`, {
          cause: error,
        });
      });
      expect(parsed.rawText.length, extension).toBeGreaterThan(0);
      expect(parsed.format, extension).toBe(extension);
    }
  }, 60_000);
});
