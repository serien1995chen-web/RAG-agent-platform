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
  it('freezes native formats and the FastGPT-compatible Office extension set', () => {
    expect(PARSE_FORMAT_MATRIX).toHaveLength(11);
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
      'office',
    ]);
    expect(resolveParseFormat('.TXT')?.format).toBe('text');
    expect(resolveParseFormat('markdown')?.format).toBe('markdown');
    expect(resolveParseFormat('htm')?.format).toBe('html');
    expect(resolveParseFormat('epub')?.format).toBe('ebook');
    expect(resolveParseFormat('ofd')?.format).toBe('ofd');
    expect(resolveParseFormat('doc')?.format).toBe('office');
    expect(resolveParseFormat('wps')?.format).toBe('office');
    expect(resolveParseFormat('odt')?.format).toBe('office');
  });

  it('maps every matrix format to a registered parser', () => {
    const registry = createParserRegistry();
    expect(registry.size).toBe(11);
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
    expect(registry.resolveByMime('application/msword')).toBe('office');
    expect(registry.resolveByMime('application/vnd.oasis.opendocument.text')).toBe('office');
    expect(normalizeMimeType('application/pdf; foo=bar')).toBe('application/pdf');
    expect(normalizeExtension('.DocX')).toBe('docx');
  });

  it('rejects unknown formats with KNOWLEDGE_UNSUPPORTED_CONTENT and never silently degrades', () => {
    const registry = createParserRegistry();
    expect(registry.resolveByExtension('rtf')).toBe('office');
    expect(registry.resolveByExtension('unknown')).toBeNull();
    const error = unsupportedFormatError('unknown', 'req-1');
    expect(error.problem.error.code).toBe('KNOWLEDGE_UNSUPPORTED_CONTENT');
  });
});
