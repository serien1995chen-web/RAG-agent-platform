import { existsSync, readFileSync } from 'node:fs';
import Module from 'node:module';
import { dirname, resolve } from 'node:path';
import { KnowledgeApiError, createKnowledgeError } from '@kb/contracts';
import type { ParseHandler, ParseResult } from '../format-registry';
import { contentHashOf, parseFailedError } from '../format-registry';
import { parseDocx } from './docx';
import { parsePptx } from './pptx';
import { parseXlsx } from './xlsx';

const OFFICE_OXIDE_FORMATS = new Set([
  'doc',
  'docm',
  'wps',
  'ppt',
  'pps',
  'pot',
  'pptm',
  'ppsx',
  'ppsm',
  'xls',
  'xlsm',
  'xlsb',
]);

const OPEN_DOCUMENT_FORMATS = new Set(['odt', 'ods', 'odp', 'rtf']);

interface OfficeOxideModule {
  WasmDocument: new (
    bytes: Uint8Array,
    format: 'docx' | 'xlsx' | 'pptx' | 'doc' | 'xls' | 'ppt',
  ) => {
    toMarkdown(): string;
    plainText(): string;
    free(): void;
  };
}

let officeOxideModule: OfficeOxideModule | null = null;

function loadOfficeOxide(fileRef: string): OfficeOxideModule {
  if (officeOxideModule) return officeOxideModule;
  const entry = [
    resolve(process.cwd(), 'node_modules/office-oxide-wasm/node/office_oxide.js'),
    resolve(
      process.cwd(),
      '../../packages/parse/node_modules/office-oxide-wasm/node/office_oxide.js',
    ),
    resolve(process.cwd(), 'packages/parse/node_modules/office-oxide-wasm/node/office_oxide.js'),
  ].find(existsSync);
  if (!entry) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
      requestId: fileRef,
      traceId: fileRef,
      details: { dependency: 'office-oxide-wasm' },
    });
  }
  const compiled = new Module(entry);
  compiled.filename = entry;
  compiled.paths = (
    Module as typeof Module & { _nodeModulePaths(from: string): string[] }
  )._nodeModulePaths(dirname(entry));
  (
    compiled as Module & {
      _compile(source: string, filename: string): void;
    }
  )._compile(readFileSync(entry, 'utf8'), entry);
  officeOxideModule = compiled.exports as OfficeOxideModule;
  return officeOxideModule;
}

function canonicalOfficeFormat(
  extension: string,
  bytes: Uint8Array,
): 'docx' | 'xlsx' | 'pptx' | 'doc' | 'xls' | 'ppt' {
  const normalized = extension.toLowerCase();
  if (normalized === 'wps') {
    const zip =
      bytes[0] === 0x50 &&
      bytes[1] === 0x4b &&
      (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
    return zip ? 'docx' : 'doc';
  }
  if (['docm', 'dotx', 'dotm'].includes(normalized)) return 'docx';
  if (['xlsm', 'xlsb', 'xltx', 'xltm'].includes(normalized)) return 'xlsx';
  if (['pptm', 'ppsx', 'ppsm', 'potx', 'potm'].includes(normalized)) {
    return 'pptx';
  }
  if (['ppt', 'pps', 'pot'].includes(normalized)) return 'ppt';
  if (normalized === 'xls') return 'xls';
  if (normalized === 'ppt') return 'ppt';
  if (normalized === 'doc') return 'doc';
  return 'docx';
}

async function parseWithOfficeOxide(
  extension: string,
  bytes: Uint8Array,
  fileRef: string,
): Promise<{ markdown: string; parserVersion: string }> {
  const { WasmDocument } = loadOfficeOxide(fileRef);
  const document = new WasmDocument(bytes, canonicalOfficeFormat(extension, bytes));
  try {
    const markdown = document.toMarkdown().trim();
    return {
      markdown: markdown || document.plainText().trim(),
      parserVersion: 'office-oxide-wasm@0.1.8',
    };
  } finally {
    document.free();
  }
}

async function parseWithOfficeParser(
  extension: string,
  bytes: Uint8Array,
  fileRef: string,
): Promise<{ markdown: string; parserVersion: string }> {
  const moduleName = 'officeparser';
  const module = (await import(moduleName)) as {
    default?: {
      parseOffice(
        input: Uint8Array,
        options: { fileType: string },
      ): Promise<{ to(format: 'md'): Promise<{ value: string }> }>;
    };
    parseOffice?(
      input: Uint8Array,
      options: { fileType: string },
    ): Promise<{ to(format: 'md'): Promise<{ value: string }> }>;
  };
  const parseOffice = module.parseOffice ?? module.default?.parseOffice;
  if (!parseOffice) {
    throw parseFailedError(extension, 'officeparser_module_invalid', fileRef);
  }
  const document = await parseOffice(bytes, { fileType: extension });
  const markdown = (await document.to('md')).value.trim();
  return { markdown, parserVersion: 'officeparser@7.8.0' };
}

export const parseOfficeDocument: ParseHandler = async ({ request, bytes }) => {
  const extension = request.extension.replace(/^\./, '').toLowerCase();
  if (bytes.byteLength === 0) {
    throw parseFailedError(extension, 'empty_document', request.fileRef);
  }
  try {
    const zip =
      bytes[0] === 0x50 &&
      bytes[1] === 0x4b &&
      (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
    if (zip && ['docm', 'wps'].includes(extension)) {
      return parseDocx({ request: { ...request, extension: 'docx' }, bytes });
    }
    if (zip && ['pptm', 'ppsx', 'ppsm'].includes(extension)) {
      return parsePptx({ request: { ...request, extension: 'pptx' }, bytes });
    }
    if (['xlsm', 'xlsb'].includes(extension)) {
      return parseXlsx({ request: { ...request, extension: 'xlsx' }, bytes });
    }
    const parsed = OFFICE_OXIDE_FORMATS.has(extension)
      ? await parseWithOfficeOxide(extension, bytes, request.fileRef)
      : OPEN_DOCUMENT_FORMATS.has(extension)
        ? await parseWithOfficeParser(extension, bytes, request.fileRef)
        : null;
    if (!parsed || !parsed.markdown.trim()) {
      throw parseFailedError(extension, 'empty_document_text', request.fileRef);
    }
    return {
      format: extension,
      rawText: parsed.markdown,
      pages: [{ pageNumber: 1, text: parsed.markdown, assets: [] }],
      assets: [],
      diagnostics: [],
      scanRequired: false,
      imageRefs: [],
      contentHash: contentHashOf(parsed.markdown),
      parserVersion: parsed.parserVersion,
      configHash: contentHashOf(`${parsed.parserVersion}:${extension}`),
    } satisfies ParseResult;
  } catch (error) {
    if (error instanceof KnowledgeApiError) throw error;
    const message = error instanceof Error ? error.message : 'unknown_parse_error';
    throw parseFailedError(extension, message.slice(0, 160), request.fileRef);
  }
};
