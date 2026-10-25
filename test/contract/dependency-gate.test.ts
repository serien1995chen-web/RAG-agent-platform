import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const checker = resolve(repositoryRoot, 'scripts/check-licenses.mjs');
const dependencyDir = resolve(repositoryRoot, 'packages/contracts/src/dependencies');
const catalogSource = readFileSync(resolve(repositoryRoot, 'pnpm-workspace.yaml'), 'utf8');
const ledgerFixture = () =>
  JSON.parse(
    readFileSync(join(dependencyDir, 'npm-dependency-baseline.data.json'), 'utf8'),
  ) as Array<Record<string, unknown>>;
const auditFixture = () =>
  JSON.parse(readFileSync(join(dependencyDir, 'npm-dependency-audit.data.json'), 'utf8')) as Array<
    Record<string, unknown>
  >;

const workspaceManifests = [
  ['packages/acl', '@kb/acl'],
  ['packages/chunk', '@kb/chunk'],
  ['packages/contracts', '@kb/contracts'],
  ['packages/dal', '@kb/dal'],
  ['packages/parse', '@kb/parse'],
  ['packages/qa', '@kb/qa'],
  ['packages/search', '@kb/search'],
  ['packages/service', '@kb/service'],
  ['packages/web', '@kb/web'],
  ['projects/app', '@kb/app'],
  ['sdk/otel', '@kb/otel'],
  ['sdk/storage', '@kb/storage'],
] as const;

type FixtureMutation = {
  ledger?: (entries: Array<Record<string, unknown>>) => void;
  audit?: (entries: Array<Record<string, unknown>>) => void;
  catalog?: string;
};

function runFixture(mutation: FixtureMutation = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kb-dependency-gate-'));
  try {
    const ledger = ledgerFixture();
    const audit = auditFixture();
    mutation.ledger?.(ledger);
    mutation.audit?.(audit);

    writeFileSync(
      join(root, 'package.json'),
      `${JSON.stringify(
        {
          name: 'dependency-gate-fixture',
          version: '0.1.0',
          private: true,
          devDependencies: {
            '@playwright/test': 'catalog:',
            '@axe-core/playwright': 'catalog:',
          },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(join(root, 'pnpm-workspace.yaml'), mutation.catalog ?? catalogSource);
    for (const [directory, name] of workspaceManifests) {
      mkdirSync(join(root, directory), { recursive: true });
      writeFileSync(
        join(root, directory, 'package.json'),
        `${JSON.stringify({ name, version: '0.1.0', private: true }, null, 2)}\n`,
      );
    }
    mkdirSync(join(root, 'packages/contracts/src/dependencies'), {
      recursive: true,
    });
    writeFileSync(
      join(root, 'packages/contracts/src/dependencies/npm-dependency-baseline.data.json'),
      `${JSON.stringify(ledger, null, 2)}\n`,
    );
    writeFileSync(
      join(root, 'packages/contracts/src/dependencies/npm-dependency-audit.data.json'),
      `${JSON.stringify(audit, null, 2)}\n`,
    );

    return spawnSync(process.execPath, [checker, '--dependency-only', '--root', root], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      timeout: 30_000,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('dependency-only license gate', () => {
  it('accepts the complete baseline fixture', () => {
    const result = runFixture();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('dependency gate 通过');
  });

  it('fails when a ledger entry is missing', () => {
    const result = runFixture({
      ledger: (entries) => entries.pop(),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('dependency ledger 应为 166 项');
  });

  it('fails when a ledger name is duplicated', () => {
    const result = runFixture({
      ledger: (entries) => {
        entries[1] = structuredClone(entries[0]!);
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('名称重复');
  });

  it('fails when a ledger version is a range', () => {
    const result = runFixture({
      ledger: (entries) => {
        entries[0]!.version = '^1.0.0';
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('版本必须精确');
  });

  it('fails when an ownerStage is unknown', () => {
    const result = runFixture({
      ledger: (entries) => {
        entries[0]!.ownerStage = 'S99';
      },
      audit: (entries) => {
        entries[0]!.ownerStage = 'S99';
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('未知 ownerStage');
  });

  it('fails when the catalog contains an unregistered package', () => {
    const result = runFixture({
      catalog: catalogSource.replace(
        '\ncatalogMode:',
        '\n  rogue-dependency: 1.0.0\n\ncatalogMode:',
      ),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('catalog 出现未登记依赖 rogue-dependency');
  });
});
