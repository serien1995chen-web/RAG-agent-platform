import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const fixtureRoot = join(root, 'test', 'fixtures', 'b18-b');
const fastgptRoot = (process.env.FASTGPT_REFERENCE_ROOT ?? '/mnt/d/Fastgpt/FastGPT').trim();
const fastgptReferenceAvailable = existsSync(fastgptRoot);
const matrix = JSON.parse(readFileSync(join(fixtureRoot, 'behavior-matrix.json'), 'utf8')) as {
  cases: Array<{
    capability: string;
    subtestId: string;
    responsibility: string;
    fastgptEvidence: Array<{ path: string; lines: string; behavior: string }>;
    frontendBehaviorIds: string[];
    downstreamAction: string;
    expectedUserVisibleResult: string;
    statusSemantics: string;
    persistenceAndSideEffects: string;
    permissions: string;
    allowedDifferences: string;
    projectAcceptanceExtension: boolean;
    unresolved: boolean;
  }>;
};
const audit = JSON.parse(readFileSync(join(fixtureRoot, 'test-asset-audit.json'), 'utf8')) as {
  assets: Array<{ path: string; decision: string }>;
  newAssets: string[];
};
const manifest = JSON.parse(readFileSync(join(fixtureRoot, 'fixture-manifest.json'), 'utf8')) as {
  candidateSha: string;
  fastgpt: {
    observedVersion: string;
    keyFiles: Record<string, string>;
  };
};

function lineCount(path: string): number {
  return readFileSync(path, 'utf8').split(/\r?\n/).length;
}

function parseLineRanges(value: string): Array<{ start: number; end: number }> {
  return value.split(',').flatMap((part) => {
    const [left, right] = part.trim().split('-');
    const start = Number(left);
    const end = Number(right ?? left);
    return Number.isInteger(start) && Number.isInteger(end) ? [{ start, end }] : [];
  });
}

describe('B18-B behavior matrix and test asset completeness', () => {
  it('binds the frozen project SHA and actual FastGPT 4.17.3 source', () => {
    expect(manifest.candidateSha).toBe('c34467da5a16ef0cc0efff65c696d9a2cf408ff0');
    expect(manifest.fastgpt.observedVersion).toBe('4.17.3');
    for (const [relativePath, expectedHash] of Object.entries(manifest.fastgpt.keyFiles)) {
      expect(relativePath.startsWith('/'), relativePath).toBe(false);
      expect(relativePath.split('/'), relativePath).not.toContain('..');
      expect(expectedHash, relativePath).toMatch(/^[a-f0-9]{64}$/);
      if (fastgptReferenceAvailable) {
        const absolutePath = join(fastgptRoot, relativePath);
        expect(existsSync(absolutePath), relativePath).toBe(true);
        expect(createHash('sha256').update(readFileSync(absolutePath)).digest('hex')).toBe(
          expectedHash,
        );
      }
    }
  });

  it('covers P/N/A/S/C/F/Q/UI exactly once for every DOWN capability', () => {
    const capabilities = ['DOWN-001', 'DOWN-002', 'DOWN-003', 'DOWN-004'];
    const suffixes = ['-P01', '-N01', '-A01', '-S01', '-C01', '-F01', '-Q01', '-UI01'];
    expect(matrix.cases).toHaveLength(32);
    for (const capability of capabilities) {
      const rows = matrix.cases.filter((item) => item.capability === capability);
      expect(rows).toHaveLength(8);
      expect(rows.map((item) => item.subtestId.slice(-4)).sort()).toEqual(
        suffixes.map((item) => item.slice(-4)).sort(),
      );
      expect(new Set(rows.map((item) => item.subtestId)).size).toBe(8);
      for (const row of rows) {
        for (const field of [
          'responsibility',
          'fastgptEvidence',
          'frontendBehaviorIds',
          'downstreamAction',
          'expectedUserVisibleResult',
          'statusSemantics',
          'persistenceAndSideEffects',
          'permissions',
          'allowedDifferences',
        ] as const) {
          expect(row[field], `${row.subtestId}.${field}`).toBeTruthy();
        }
        expect(row.unresolved).toBe(false);
      }
    }
  });

  it('keeps every FastGPT source reference readable and within file bounds', () => {
    for (const row of matrix.cases) {
      expect(row.fastgptEvidence.length, row.subtestId).toBeGreaterThan(0);
      for (const evidence of row.fastgptEvidence) {
        expect(evidence.path.startsWith('/'), `${row.subtestId}: ${evidence.path}`).toBe(false);
        expect(evidence.path.split('/'), `${row.subtestId}: ${evidence.path}`).not.toContain('..');
        const ranges = parseLineRanges(evidence.lines);
        expect(
          ranges.length,
          `${row.subtestId}: invalid line range ${evidence.lines}`,
        ).toBeGreaterThan(0);
        for (const range of ranges) {
          expect(range.start, `${row.subtestId}: ${evidence.path}`).toBeGreaterThan(0);
          expect(range.end, `${row.subtestId}: ${evidence.path}`).toBeGreaterThanOrEqual(
            range.start,
          );
          if (fastgptReferenceAvailable) {
            const absolutePath = join(fastgptRoot, evidence.path);
            expect(existsSync(absolutePath), `${row.subtestId}: ${evidence.path}`).toBe(true);
            expect(range.end, `${row.subtestId}: ${evidence.path}`).toBeLessThanOrEqual(
              lineCount(absolutePath),
            );
          }
        }
      }
    }
  });

  it('audits all baseline assets and declares complete B18-B test assets', () => {
    for (const path of [
      'test/contract/s7-downstream-contract.test.ts',
      'test/contract/s7-multi-space.test.ts',
      'test/e2e/s7-downstream-consumers.test.ts',
      'test/e2e/s7-search-page.test.ts',
      'test/e2e/s10-downstream-real-key.test.ts',
      'test/e2e/kb-b19-api-key-http.test.ts',
      'test/security/s10-api-key-auth.test.ts',
      'test/security/s10-secret-leak.test.ts',
      'test/security/s11-api-key-tenant.test.ts',
      'test/tenant/s10-api-key-tenant.test.ts',
      'test/concurrency/s10-api-key-concurrency.test.ts',
      'test/fault/kb-b19-api-key-fault.test.ts',
      'packages/service/test/integration/s10-api-key.test.ts',
      'packages/web/test/unit/s7-downstream-client.test.ts',
    ]) {
      expect(
        audit.assets.find((item) => item.path === path),
        path,
      ).toBeTruthy();
    }
    for (const entry of audit.assets) {
      expect(['REUSE', 'EXTEND', 'NEW', 'STALE', 'BLOCKED']).toContain(entry.decision);
    }
    for (const relativePath of audit.newAssets) {
      expect(existsSync(join(root, relativePath)), relativePath).toBe(true);
    }
  });
});

describe('B18-B independent consumer boundary', () => {
  const consumer = readFileSync(join(fixtureRoot, 'consumer-entry.ts'), 'utf8');
  const page = readFileSync(join(fixtureRoot, 'consumer-page.html'), 'utf8');

  it('imports contracts and Node built-ins only', () => {
    expect(consumer).toContain("from '@kb/contracts'");
    expect(consumer).toContain('process.stdin');
    expect(consumer).toContain('fetch(');
    expect(consumer).not.toMatch(/@kb\/(?:service|dal|search)/);
    expect(consumer).not.toMatch(
      /(?:from|import\s*\()\s*['"](?:mongoose|mongodb|ioredis|bullmq|pg|minio|@aws-sdk|@kb\/service|@kb\/dal)/,
    );
    expect(consumer).not.toMatch(/process\.env\.(?:KB_MONGO|KB_REDIS|KB_PG|KB_S3)/);
    expect(consumer).not.toContain('objectKey');
  });

  it('limits consumer HTTP paths to the public knowledge API', () => {
    expect(consumer).toContain("url.pathname.startsWith('/v1/knowledge/')");
    for (const path of [
      '/v1/knowledge/search/multi-space',
      '/v1/knowledge/search/semantic',
      '/v1/knowledge/search/image',
      '/v1/knowledge/search/hybrid',
      '/v1/knowledge/citations/',
      '/v1/knowledge/jobs/',
      '/v1/knowledge/spaces/',
    ]) {
      expect(consumer).toContain(path);
    }
    expect(consumer).not.toMatch(/https?:\/\/127\.0\.0\.1|knowledge\.example\.invalid/);
  });

  it('keeps the browser API key server-side and uses same-origin knowledge paths', () => {
    expect(page).not.toContain('KB_B18_API_KEY');
    expect(page).not.toContain('kn_live_');
    expect(page).not.toMatch(/localStorage\.setItem\([^)]*(?:key|token|secret)/i);
    expect(page).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
    expect(page).toContain('/v1/knowledge/search/multi-space');
    expect(page).toContain('/v1/knowledge/search/semantic');
    expect(page).toContain('/v1/knowledge/search/hybrid');
    expect(page).toContain('/v1/knowledge/citations/');
  });

  it('does not treat the same-process fake server as acceptance proof', () => {
    const fake = readFileSync(join(root, 'test/e2e/s7-downstream-consumers.test.ts'), 'utf8');
    expect(fake).toContain('createServer');
    expect(
      audit.assets.find((item) => item.path.endsWith('s7-downstream-consumers.test.ts')),
    ).toMatchObject({ decision: 'REUSE' });
    const notes = readFileSync(join(fixtureRoot, 'test-asset-audit.json'), 'utf8');
    expect(notes).toContain('same-process fake HTTP server');
    expect(notes).toContain('insufficient');
  });
});
