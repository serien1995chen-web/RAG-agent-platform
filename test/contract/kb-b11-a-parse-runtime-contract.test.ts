import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

describe('L1-B11-A PARSE runtime selection contract', () => {
  it('L1-B11-A-PARSE-002-P03 routes selected external Providers and their configuration through the parse Job', () => {
    const runtime = readFileSync(
      join(root, 'projects', 'app', 'src', 'runtime', 'knowledge-runtime.ts'),
      'utf8',
    );
    const processing = readFileSync(
      join(
        root,
        'packages',
        'service',
        'src',
        'modules',
        'knowledge',
        'application',
        's06-processing.application.ts',
      ),
      'utf8',
    );
    expect(processing).toMatch(/parseConfig/);
    expect(runtime).toMatch(/input\.parseProvider[\s\S]{0,800}s5Ocr\.parse/);
    const externalBranch = runtime.indexOf("if (parseProvider !== 'liteparse')");
    const localPdfBranch = runtime.indexOf("if (input.mimeType === 'application/pdf'");
    expect(externalBranch).toBeGreaterThanOrEqual(0);
    expect(localPdfBranch).toBeGreaterThan(externalBranch);
  });
});
