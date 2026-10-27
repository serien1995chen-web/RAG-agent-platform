import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const checker = resolve(repositoryRoot, 'scripts/check-licenses.mjs');
const licenseModule = (await import(
  new URL('../../scripts/check-licenses.mjs', import.meta.url).href
)) as {
  NPM_LICENSE_WHITELIST: string[];
  PENDING_LEGAL_REVIEW: Array<{
    name: string;
    version: string;
    expression: string;
    parentChain: string;
    status: string;
    releaseBlocking: boolean;
  }>;
};

describe('S4 license gate decision', () => {
  it('keeps exactly five release-blocking legal review entries', () => {
    expect(licenseModule.PENDING_LEGAL_REVIEW).toHaveLength(5);
    expect(licenseModule.PENDING_LEGAL_REVIEW).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'argparse',
          version: '2.0.1',
          expression: 'Python-2.0',
          status: 'pending-legal-review',
          releaseBlocking: true,
        }),
        expect.objectContaining({
          name: 'jschardet',
          version: '3.1.1',
          expression: 'LGPL-2.1+',
          status: 'pending-legal-review',
          releaseBlocking: true,
        }),
      ]),
    );
    expect(licenseModule.NPM_LICENSE_WHITELIST).not.toContain('Python-2.0');
    expect(licenseModule.NPM_LICENSE_WHITELIST).not.toContain('LGPL-2.1+');
  });

  it('passes the full license gate while reporting all five blockers', () => {
    const result = spawnSync(process.execPath, [checker], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      timeout: 30_000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('RELEASE BLOCKER（pending-legal-review，5 条');
    for (const id of [
      'caniuse-lite@1.0.30001814',
      'pako@1.0.11',
      'sax@1.6.1',
      'argparse@2.0.1',
      'jschardet@3.1.1',
    ]) {
      expect(result.stdout).toContain(id);
    }
  });
});
