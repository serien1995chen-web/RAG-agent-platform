import { describe, expect, it } from 'vitest';
import { md5Hex } from '../../src/features/kb/lib/md5';

const encoder = new TextEncoder();

describe('browser MD5 helper', () => {
  it('matches known vectors', () => {
    expect(md5Hex(encoder.encode(''))).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5Hex(encoder.encode('abc'))).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5Hex(encoder.encode('The quick brown fox jumps over the lazy dog'))).toBe(
      '9e107d9d372bb6826bd81d3542a419d6',
    );
  });
});
