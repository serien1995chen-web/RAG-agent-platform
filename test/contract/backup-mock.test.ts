import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RequestContext } from '../../packages/service/src/ports/types';
import {
  BackupToolAdapter,
  createBackupToolAdapter,
} from '../../packages/service/src/modules/migration/adapter/backup-tool.adapter';

const context: RequestContext = {
  requestId: 'req-backup-mock',
  tenant: {
    teamId: 'team-a',
    tmbId: 'tmb-a',
    authType: 'root',
    isRoot: true,
  },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
};

function runbook(name: string): string {
  return readFileSync(new URL(`../../docs/runbooks/${name}`, import.meta.url), 'utf8');
}

describe('BackupToolPort mock contract (TEST-BACKUP-MOCK-001, TEST-OPS-RESTORE-001, TEST-OPS-RUNBOOK-001)', () => {
  it('returns 501062 when the backup command is not configured', async () => {
    const adapter = createBackupToolAdapter();
    await expect(
      adapter.validate({ command: {}, options: { timeoutMs: 1_000 } }, context),
    ).rejects.toMatchObject({ error: { code: 501062 } });
  });

  it('returns mock evidence and never marks mock evidence as verified', async () => {
    const adapter = new BackupToolAdapter();
    const command = {
      toolRef: 'private-backup-tool',
      artifactRef: 'mongo:snapshot:1',
      changeId: 'change-1',
    };
    const validated = await adapter.validate(
      { command, options: { timeoutMs: 1_000 } },
      context,
    );
    expect(validated).toEqual({ valid: true });

    const result = await adapter.run({ command, options: { timeoutMs: 1_000 } }, context);
    expect(result.evidence).toMatchObject({
      changeId: 'change-1',
      toolRef: 'private-backup-tool',
      artifactRef: 'mongo:snapshot:1',
      checksum: expect.stringMatching(/^sha256:/),
      mode: 'mock',
      completedAt: expect.any(String),
    });
    await expect(
      adapter.verify({ evidence: result.evidence, options: { timeoutMs: 1_000 } }, context),
    ).resolves.toEqual({ verified: false });
    await expect(
      adapter.verify(
        {
          evidence: {
            changeId: 'change-1',
            toolRef: 'private-backup-tool',
            artifactRef: 'mongo:snapshot:1',
            mode: 'mock',
          },
          options: { timeoutMs: 1_000 },
        },
        context,
      ),
    ).resolves.toEqual({ verified: false });
  });

  it('requires all runbook evidence fields and documents mock status', () => {
    const backupRestore = runbook('backup-restore.md');
    const release = runbook('release.md');
    const releaseRollback = runbook('release-rollback.md');

    for (const body of [backupRestore, release, releaseRollback]) {
      expect(body).toMatch(/changeId/);
      expect(body).toMatch(/runbookUri/);
      expect(body).toMatch(/runbookVersion/);
      expect(body).toMatch(/rollbackInfo/);
      expect(body).toMatch(/approvalRole/);
    }
    expect(backupRestore).toMatch(/Stop writes/);
    expect(backupRestore).toMatch(/MongoDB/);
    expect(backupRestore).toMatch(/PostgreSQL\/pgvector/);
    expect(backupRestore).toMatch(/S3/);
    expect(backupRestore).toMatch(/Data Comparison/);
    expect(backupRestore).toMatch(/Drill Record/);
    expect(backupRestore).toMatch(/mock run is not a real recovery/);
  });
});
