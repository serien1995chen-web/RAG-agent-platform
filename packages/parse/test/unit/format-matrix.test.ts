import { describe, expect, it } from 'vitest';
import {
  createParserRegistry,
  normalizeMimeType,
  normalizeExtension,
  PARSE_FORMAT_MATRIX,
  resolveParseFormat,
} from '../../src/index';
import { unsupportedFormatError } from '../../src/format-registry';

describe('TEST-PARSE-FORMAT-001 parser format matrix', () => {
  it('freezes the nine baseline formats plus OFD with documented extensions', () => {
    expect(PARSE_FORMAT_MATRIX).toHaveLength(10);
    expect(PARSE_FORMAT_MATRIX.map((spec) => spec.format)).toEqual([
      'text',
      'markdown',
      'html',
      'pdf',
      'docx',
      'pptx',
      'xlsx',
      'csv',
      'ebook',
      'ofd',
    ]);
    expect(resolveParseFormat('.TXT')?.format).toBe('text');
    expect(resolveParseFormat('markdown')?.format).toBe('markdown');
    expect(resolveParseFormat('htm')?.format).toBe('html');
    expect(resolveParseFormat('epub')?.format).toBe('ebook');
    expect(resolveParseFormat('ofd')?.format).toBe('ofd');
  });

  it('maps every matrix format to a registered parser', () => {
    const registry = createParserRegistry();
    expect(registry.size).toBe(10);
    for (const spec of PARSE_FORMAT_MATRIX) {
      for (const extension of spec.extensions) {
        expect(registry.resolveByExtension(extension)).toBe(spec.format);
      }
    }
  });

  it('resolves by MIME when extension is absent', () => {
    const registry = createParserRegistry();
    expect(registry.resolveByMime('text/html; charset=utf-8')).toBe('html');
    expect(registry.resolveByMime('application/pdf')).toBe('pdf');
    expect(normalizeMimeType('application/pdf; foo=bar')).toBe('application/pdf');
    expect(normalizeExtension('.DocX')).toBe('docx');
  });

  it('rejects unknown formats with KNOWLEDGE_UNSUPPORTED_CONTENT and never silently degrades', () => {
    const registry = createParserRegistry();
    expect(registry.resolveByExtension('rtf')).toBeNull();
    const error = unsupportedFormatError('rtf', 'req-1');
    expect(error.problem.error.code).toBe('KNOWLEDGE_UNSUPPORTED_CONTENT');
  });
});
