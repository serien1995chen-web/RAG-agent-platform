import { describe, expect, it } from 'vitest';
import {
  S8_IMAGE_MAX_BYTES,
  assertS8ImageCount,
  assertS8ImageMedia,
  detectS8ImageMime,
} from '../../src/modules/knowledge/application/s8-image-policy';

const context = { requestId: 'req-s8-image-policy', traceId: 'trace-s8-image-policy' };
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('S8 image media policy', () => {
  it('accepts PNG, JPEG, WebP and GIF magic and enforces the count range', () => {
    expect(detectS8ImageMime(png)).toBe('image/png');
    expect(detectS8ImageMime(Uint8Array.from([0xff, 0xd8, 0xff]))).toBe('image/jpeg');
    expect(
      detectS8ImageMime(
        Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
      ),
    ).toBe('image/webp');
    expect(detectS8ImageMime(Buffer.from('GIF89a'))).toBe('image/gif');
    expect(() => assertS8ImageCount(10, context)).not.toThrow();
    expect(() => assertS8ImageCount(0, context)).toThrow();
    expect(() => assertS8ImageCount(11, context)).toThrow();
  });

  it('enforces size, extension, MIME and magic consistency', () => {
    expect(() =>
      assertS8ImageMedia(
        { mimeType: 'image/png', fileName: 'cover.png', sizeBytes: png.byteLength, bytes: png },
        context,
      ),
    ).not.toThrow();
    expect(() =>
      assertS8ImageMedia(
        {
          mimeType: 'image/png',
          fileName: 'cover.png',
          sizeBytes: S8_IMAGE_MAX_BYTES + 1,
        },
        context,
      ),
    ).toThrow();
    expect(() =>
      assertS8ImageMedia(
        { mimeType: 'image/png', fileName: 'cover.jpg', sizeBytes: png.byteLength },
        context,
      ),
    ).toThrow();
    expect(() =>
      assertS8ImageMedia(
        {
          mimeType: 'image/png',
          fileName: 'cover.png',
          sizeBytes: png.byteLength,
          bytes: Buffer.from('not-a-png'),
        },
        context,
      ),
    ).toThrow();
  });
});
