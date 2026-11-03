import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PENDING_APP_DIGEST,
  checkReleaseImages,
  loadManifest,
  parseResolvedImage,
  validateManifest,
} from '../../scripts/check-release-images.mjs';

describe('TEST-X-S11-LICENSE-OBLIGATIONS / TEST-X-S11-RELEASE-IMAGES', () => {
  it('keeps exact approved obligations and full license texts in generated NOTICE', () => {
    const notice = readFileSync(join(process.cwd(), 'NOTICE'), 'utf8');
    expect(notice).toContain('六、许可证批准与义务（approved-2026-10-29，5 条）');
    expect(notice).toContain('用户于 2026-10-29 转述的法务批准');
    expect(notice).not.toContain('pending-legal-review');
    expect(notice).toContain('Blue Oak Model License');
    expect(notice).toContain('GNU LESSER GENERAL PUBLIC LICENSE');
    expect(notice).toContain('Creative Commons Attribution 4.0 International');
    expect(notice).toContain('licenseTextEnd');
  });

  it('requires six runtime image classes and app/worker shared digest', () => {
    const manifest = loadManifest();
    expect(validateManifest(manifest)).toEqual([]);
    expect(manifest.services.map((entry: { service: string }) => entry.service)).toEqual([
      'mongo',
      'redis',
      'pgvector',
      'minio',
      'aiproxy',
      'app',
      'worker',
    ]);
    expect(manifest.services.at(-2)).toMatchObject({
      service: 'app',
      digest: PENDING_APP_DIGEST,
    });
    expect(manifest.services.at(-1)).toMatchObject({
      service: 'worker',
      digest: PENDING_APP_DIGEST,
    });
  });

  it('treats the production app digest as deferred instead of a scoped failure', () => {
    const result = checkReleaseImages({
      env: { ...process.env, KB_APP_IMAGE_REF: '' },
      allowMissingApp: true,
    });
    expect(result.errors).toEqual([]);
    expect(result.status).toBe('DEFERRED_TO_PRODUCTION');
    expect(result.deferred).toEqual([
      expect.objectContaining({
        code: 'APP_IMAGE_DIGEST_PENDING',
        status: 'DEFERRED_TO_PRODUCTION',
      }),
    ]);
  }, 30_000);

  it('parses only tag plus sha256 digest references', () => {
    expect(
      parseResolvedImage(
        'registry.example.test/rag-agent-platform:2026.10.29@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ),
    ).toMatchObject({
      repository: 'registry.example.test/rag-agent-platform',
      tag: '2026.10.29',
      digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(parseResolvedImage('rag-agent-platform:latest')).toBeNull();
  });
});
