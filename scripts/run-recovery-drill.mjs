#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repositoryRoot = resolve(import.meta.dirname, '..');

export const RECOVERY_FAULT_MATRIX = Object.freeze([
  'mongo',
  'redis',
  'postgres',
  'minio',
  'aiproxy',
  'worker_restart',
  'backup_restore',
  'reconcile',
]);

export const REQUIRED_CONTAINER_TOOLS = Object.freeze({
  mongo: ['mongodump', 'mongorestore', 'mongosh'],
  pgvector: ['pg_dump', 'pg_restore', 'psql'],
  minio: ['mc', 'curl'],
  redis: ['redis-cli', 'redis-server'],
});

function firstLine(value) {
  return String(value ?? '')
    .trim()
    .split('\n')[0]
    .slice(0, 240);
}

export class ContainerRecoveryExecutor {
  constructor(input = {}) {
    this.env = input.env ?? process.env;
    this.composeFile =
      input.composeFile ??
      this.env.S11_RECOVERY_COMPOSE_FILE ??
      join(repositoryRoot, 'deploy', 'docker-compose.yml');
    this.runner = input.runner ?? spawnSync;
  }

  exec(service, command, args = []) {
    return this.runner(
      'docker',
      ['compose', '-f', this.composeFile, 'exec', '-T', service, command, ...args],
      {
        encoding: 'utf8',
        env: this.env,
        cwd: repositoryRoot,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
  }

  probe() {
    const services = {};
    let ready = true;
    for (const [service, tools] of Object.entries(REQUIRED_CONTAINER_TOOLS)) {
      services[service] = {};
      for (const tool of tools) {
        const located = this.exec(service, 'sh', ['-lc', 'command -v "$1"', 'tool-probe', tool]);
        const available = located.status === 0;
        if (!available) ready = false;
        const version =
          available && tool !== 'curl' ? this.exec(service, tool, ['--version']) : null;
        services[service][tool] = {
          available,
          path: available ? firstLine(located.stdout) : null,
          version:
            version && version.status === 0
              ? firstLine(version.stdout) || firstLine(version.stderr) || 'UNKNOWN'
              : null,
        };
      }
    }
    return {
      status: ready ? 'READY' : 'BLOCKED',
      composeFile: this.composeFile,
      services,
    };
  }
}

export function assertIsolatedTarget(value, kind) {
  const prefix = kind === 'restore' ? 'kb_s11_restore_' : 'kb_s11_';
  if (typeof value !== 'string' || !value.startsWith(prefix)) {
    throw new Error(`${kind} target must start with ${prefix}`);
  }
  return value;
}

export function buildMongoDump(input) {
  assertIsolatedTarget(input.sourcePrefix, 'source');
  return {
    command: 'mongodump',
    service: 'mongo',
    args: ['--uri', '$KB_MONGO_URI', '--archive', input.archivePath, '--gzip'],
    env: input.env,
  };
}

export function buildPgDump(input) {
  assertIsolatedTarget(input.sourcePrefix, 'source');
  return {
    command: 'pg_dump',
    service: 'pgvector',
    args: ['--dbname', '$KB_PG_URL', '--format=custom', '--file', input.dumpPath],
    env: input.env,
  };
}

export function buildMinioMirror(input) {
  assertIsolatedTarget(input.sourcePrefix, 'source');
  return {
    command: 'mc',
    service: 'minio',
    args: ['mirror', '--preserve', `local/${input.sourcePrefix}`, input.mirrorPath],
    env: input.env,
  };
}

export function buildRedisSnapshot(input) {
  assertIsolatedTarget(input.sourcePrefix, 'source');
  return {
    command: 'redis-cli',
    service: 'redis',
    args: ['--uri', '$REDIS_URL', '--rdb', input.rdbPath],
    env: input.env,
  };
}

export function writeManifest(input) {
  const evidenceDir = resolve(input.evidenceDir);
  const relative = evidenceDir.startsWith(`${repositoryRoot}/`)
    ? evidenceDir.slice(repositoryRoot.length + 1)
    : null;
  if (relative !== null) throw new Error('recovery evidence must stay outside the worktree');
  mkdirSync(evidenceDir, { recursive: true });
  const path = join(evidenceDir, 'recovery-manifest.json');
  writeFileSync(path, `${JSON.stringify(input.manifest, null, 2)}\n`);
  return path;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value?.startsWith('--')) continue;
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      values[key] = next;
      index += 1;
    } else {
      values[key] = true;
    }
  }
  return values;
}

export async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const args = parseArgs(argv);
  const sourcePrefix = String(args['source-prefix'] ?? env.S11_RECOVERY_SOURCE_PREFIX ?? '');
  const restorePrefix = String(args['restore-prefix'] ?? env.S11_RECOVERY_RESTORE_PREFIX ?? '');
  try {
    assertIsolatedTarget(sourcePrefix, 'source');
    if (restorePrefix) assertIsolatedTarget(restorePrefix, 'restore');
  } catch (error) {
    console.error(
      `RECOVERY_PREFIX_INVALID: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  const executor = dependencies.executor ?? new ContainerRecoveryExecutor({ env });
  const tools = executor.probe();
  const commands = [
    buildMongoDump({
      sourcePrefix,
      archivePath: '$S11_EVIDENCE_DIR/mongo.archive.gz',
      env,
    }),
    buildPgDump({
      sourcePrefix,
      dumpPath: '$S11_EVIDENCE_DIR/postgres.dump',
      env,
    }),
    buildMinioMirror({
      sourcePrefix,
      mirrorPath: '$S11_EVIDENCE_DIR/minio',
      env,
    }),
    buildRedisSnapshot({
      sourcePrefix,
      rdbPath: '$S11_EVIDENCE_DIR/redis.rdb',
      env,
    }),
  ].map(({ service, command, args: commandArgs }) => ({
    service,
    command,
    args: commandArgs,
  }));
  if (args.check) {
    console.log(
      JSON.stringify(
        {
          status: tools.status,
          mode: 'check',
          sourcePrefix,
          restorePrefix: restorePrefix || null,
          tools,
          commands,
        },
        null,
        2,
      ),
    );
    if (tools.status !== 'READY') {
      console.error('RECOVERY_TOOL_UNAVAILABLE');
      console.error('RECOVERY_CHECK_BLOCKED');
      return 3;
    }
    console.log('RECOVERY_CHECK_READY');
    return 0;
  }
  if (env.S11_RECOVERY_MODE !== 'real') {
    console.error('RECOVERY_MODE_BLOCKED');
    return 2;
  }
  if (!restorePrefix) {
    console.error('RECOVERY_PREFIX_INVALID: restore prefix is required');
    return 1;
  }
  if (!env.S11_RECOVERY_CHANGE_ID) {
    console.error('RECOVERY_CHANGE_ID_REQUIRED');
    return 2;
  }
  if (!env.S11_EVIDENCE_DIR) {
    console.error('RECOVERY_EVIDENCE_DIR_REQUIRED');
    return 2;
  }
  if (tools.status !== 'READY') {
    console.error('RECOVERY_TOOL_UNAVAILABLE');
    return 3;
  }
  if (!existsSync(resolve(env.S11_EVIDENCE_DIR))) {
    mkdirSync(resolve(env.S11_EVIDENCE_DIR), { recursive: true });
  }
  console.error('RECOVERY_MEDIA_BLOCKED: real archives/snapshots must be supplied by the operator');
  return 4;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exit(await main());
}
