import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  S8_IMAGE_MAX_BYTES,
  assertS8ImageMedia,
  detectS8ImageMime,
} from '../../src/modules/knowledge/application/s8-image-policy';

const fixtureRoot = resolve(import.meta.dirname, '../../../../test/fixtures/b12');
const context = {
  requestId: 'req-b12-image-fixture',
  traceId: 'trace-b12-image-fixture-000000000000',
};

interface FixtureEntry {
  name: string;
  encodedFile: string;
  mimeType: string;
  expectedMagic: string | null;
  variant: string;
}

function manifest(): readonly FixtureEntry[] {
  return (
    JSON.parse(readFileSync(join(fixtureRoot, 'fixture-manifest.json'), 'utf8')) as {
      fixtures: FixtureEntry[];
    }
  ).fixtures;
}

function readEncoded(entry: FixtureEntry): Buffer {
  return Buffer.from(readFileSync(join(fixtureRoot, entry.encodedFile), 'utf8').trim(), 'base64');
}

describe('L1-B12-PARSE-005 and L1-B12-MULTI-001 Q01 image fixtures', () => {
  it('L1-B12-PARSE-005-Q01 recognizes deterministic PNG, JPEG, WebP, GIF and corrupt fixtures', () => {
    for (const entry of manifest()) {
      expect(detectS8ImageMime(readEncoded(entry)), entry.name).toBe(entry.expectedMagic);
    }
  });

  it('TEST-X-SECURITY-UPLOAD / L1-B12-MULTI-001-Q01 rejects corrupt, MIME mismatch and oversize media without hidden coercion', () => {
    const corrupt = manifest().find((entry) => entry.name === 'corrupt.png')!;
    expect(() =>
      assertS8ImageMedia(
        {
          mimeType: corrupt.mimeType,
          fileName: corrupt.name,
          sizeBytes: readEncoded(corrupt).byteLength,
          bytes: readEncoded(corrupt),
        },
        context,
      ),
    ).toThrow();

    const png = readEncoded(manifest().find((entry) => entry.name === 'valid-1x1.png')!);
    expect(() =>
      assertS8ImageMedia(
        {
          mimeType: 'image/jpeg',
          fileName: 'mismatch.jpg',
          sizeBytes: png.byteLength,
          bytes: png,
        },
        context,
      ),
    ).toThrow();
    expect(() =>
      assertS8ImageMedia(
        {
          mimeType: 'image/png',
          fileName: 'oversize.png',
          sizeBytes: S8_IMAGE_MAX_BYTES + 1,
        },
        context,
      ),
    ).toThrow();
  });
});
