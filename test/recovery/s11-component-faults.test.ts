import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RECOVERY_FAULT_MATRIX,
  assertIsolatedTarget,
  buildMinioMirror,
  buildMongoDump,
  buildPgDump,
  buildRedisSnapshot,
} from '../../scripts/run-recovery-drill.mjs';

const root = resolve(import.meta.dirname, '../..');

describe('TEST-X-S11-COMPONENT-FAULT / WORKER-RESTART', () => {
  it('covers every required dependency and lifecycle fault', () => {
    expect(RECOVERY_FAULT_MATRIX).toEqual([
      'mongo',
      'redis',
      'postgres',
      'minio',
      'aiproxy',
      'worker_restart',
      'backup_restore',
      'reconcile',
    ]);
  });

  it('rejects non-isolated source and restore targets', () => {
    expect(() => assertIsolatedTarget('knowledge', 'source')).toThrow('kb_s11_');
    expect(() => assertIsolatedTarget('kb_s11_restore_test', 'source')).not.toThrow();
    expect(() => assertIsolatedTarget('kb_s11_restore_test', 'restore')).not.toThrow();
    expect(() => assertIsolatedTarget('kb_s11_source', 'restore')).toThrow('kb_s11_restore_');
  });

  it('constructs commands without embedding credentials or writing the worktree', () => {
    const env = { KB_MONGO_URI: 'mongodb://secret', KB_PG_URL: 'postgresql://secret' };
    const commands = [
      buildMongoDump({
        sourcePrefix: 'kb_s11_source',
        archivePath: '/external/mongo.archive.gz',
        env,
      }),
      buildPgDump({
        sourcePrefix: 'kb_s11_source',
        dumpPath: '/external/postgres.dump',
        env,
      }),
      buildMinioMirror({
        sourcePrefix: 'kb_s11_source',
        mirrorPath: '/external/minio',
        env,
      }),
      buildRedisSnapshot({
        sourcePrefix: 'kb_s11_source',
        rdbPath: '/external/redis.rdb',
        env,
      }),
    ];
    expect(JSON.stringify(commands.map(({ command, args }) => ({ command, args })))).not.toMatch(
      /mongodb:\/\/secret|postgresql:\/\/secret|password/i,
    );
  });

  it('check mode reports missing tools without claiming a recovery PASS', () => {
    const result = spawnSync(
      process.execPath,
      [
        resolve(root, 'scripts/run-recovery-drill.mjs'),
        '--check',
        '--source-prefix',
        'kb_s11_source',
      ],
      {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('RECOVERY_CHECK_READY');
    expect(result.stdout).not.toContain('"status": "PASS"');
  });
});
