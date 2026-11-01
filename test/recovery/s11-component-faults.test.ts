import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  main,
  RECOVERY_FAULT_MATRIX,
  assertIsolatedTarget,
  buildMinioMirror,
  buildMongoDump,
  buildPgDump,
  buildRedisSnapshot,
  verifyRecoveryInputManifest,
  writeRecoveryInputManifest,
} from '../../scripts/run-recovery-drill.mjs';

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
    expect(commands[3]?.args.slice(0, 2)).toEqual(['-u', '$S11_RECOVERY_REDIS_SOURCE_URL']);
  });

  it('binds generated media to changeId and source/restore targets and detects tampering', () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 's11-recovery-media-'));
    try {
      mkdirSync(join(mediaDir, 'minio', 'evidence'), { recursive: true });
      writeFileSync(join(mediaDir, 'mongo.archive.gz'), 'mongo');
      writeFileSync(join(mediaDir, 'postgres.dump'), 'postgres');
      writeFileSync(join(mediaDir, 'redis.rdb'), 'redis');
      writeFileSync(join(mediaDir, 'minio', 'evidence', 'object.txt'), 'object');
      writeRecoveryInputManifest({
        mediaDir,
        changeId: 'change-s11-unit',
        sourcePrefix: 'kb_s11_source_unit',
        restorePrefix: 'kb_s11_restore_unit',
        tools: { status: 'READY' },
      });
      expect(
        verifyRecoveryInputManifest({
          mediaDir,
          changeId: 'change-s11-unit',
          sourcePrefix: 'kb_s11_source_unit',
          restorePrefix: 'kb_s11_restore_unit',
        }).manifest.schemaVersion,
      ).toBe(1);
      expect(() =>
        verifyRecoveryInputManifest({
          mediaDir,
          changeId: 'other-change',
          sourcePrefix: 'kb_s11_source_unit',
          restorePrefix: 'kb_s11_restore_unit',
        }),
      ).toThrow('RECOVERY_MEDIA_CHANGE_ID_MISMATCH');
      writeFileSync(join(mediaDir, 'redis.rdb'), 'tampered');
      expect(() =>
        verifyRecoveryInputManifest({
          mediaDir,
          changeId: 'change-s11-unit',
          sourcePrefix: 'kb_s11_source_unit',
          restorePrefix: 'kb_s11_restore_unit',
        }),
      ).toThrow('RECOVERY_MEDIA_HASH_MISMATCH:redis.rdb');
    } finally {
      rmSync(mediaDir, { recursive: true, force: true });
    }
  });

  it('check mode accepts only image-resident tools and never claims a recovery PASS', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitCode = await main(
      ['--check', '--source-prefix', 'kb_s11_source'],
      {},
      {
        executor: {
          probe: () => ({
            status: 'READY',
            composeFile: 'deploy/docker-compose.yml',
            services: {
              mongo: { mongodump: { available: true } },
              pgvector: { pg_dump: { available: true } },
              minio: { mc: { available: true } },
              redis: { 'redis-cli': { available: true } },
            },
          }),
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(log.mock.calls.flat().join('\n')).toContain('RECOVERY_CHECK_READY');
    expect(log.mock.calls.flat().join('\n')).not.toContain('"status": "PASS"');
    log.mockRestore();
  });

  it('check mode blocks when any required image tool is absent', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitCode = await main(
      ['--check', '--source-prefix', 'kb_s11_source'],
      {},
      {
        executor: {
          probe: () => ({
            status: 'BLOCKED',
            composeFile: 'deploy/docker-compose.yml',
            services: {},
          }),
        },
      },
    );
    expect(exitCode).toBe(3);
    expect(error.mock.calls.flat().join('\n')).toContain('RECOVERY_CHECK_BLOCKED');
    log.mockRestore();
    error.mockRestore();
  });
});
