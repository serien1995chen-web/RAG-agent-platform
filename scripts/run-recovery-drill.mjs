#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeRecovery } from './lib/recovery-summary.mjs';

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

const RECOVERY_ENV = Object.freeze({
  mongoSource: 'S11_RECOVERY_MONGO_SOURCE_URI',
  mongoRestore: 'S11_RECOVERY_MONGO_RESTORE_URI',
  pgSource: 'S11_RECOVERY_PG_SOURCE_URL',
  pgRestore: 'S11_RECOVERY_PG_RESTORE_URL',
  redisSource: 'S11_RECOVERY_REDIS_SOURCE_URL',
  redisRestore: 'S11_RECOVERY_REDIS_RESTORE_URL',
  s3Endpoint: 'S11_RECOVERY_S3_ENDPOINT',
  s3Access: 'S11_RECOVERY_S3_ACCESS_KEY',
  s3Secret: 'S11_RECOVERY_S3_SECRET_KEY',
  s3SourceBucket: 'S11_RECOVERY_S3_SOURCE_BUCKET',
  s3RestoreBucket: 'S11_RECOVERY_S3_RESTORE_BUCKET',
});

const MEDIA_NAMES = Object.freeze(['mongo.archive.gz', 'postgres.dump', 'redis.rdb', 'minio']);

function firstLine(value) {
  return String(value ?? '')
    .trim()
    .split('\n')[0]
    .slice(0, 240);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hashOfFile(path) {
  return sha256(readFileSync(path));
}

function walkFiles(directory, base = directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(path, base));
    } else if (entry.isFile()) {
      files.push({
        path,
        relative: relative(base, path).replaceAll('\\', '/'),
        sha256: hashOfFile(path),
        bytes: statSync(path).size,
      });
    }
  }
  return files.sort((left, right) => left.relative.localeCompare(right.relative));
}

function mediaEntry(mediaDir, name) {
  const path = join(mediaDir, name);
  if (!existsSync(path)) throw new Error(`RECOVERY_MEDIA_REQUIRED:${name}`);
  if (name === 'minio') {
    const files = walkFiles(path);
    const aggregate = sha256(JSON.stringify(files.map((file) => [file.relative, file.sha256])));
    return {
      name,
      type: 'directory',
      sha256: aggregate,
      bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      fileCount: files.length,
    };
  }
  return {
    name,
    type: 'file',
    sha256: hashOfFile(path),
    bytes: statSync(path).size,
  };
}

function parseLastJson(output) {
  const lines = String(output ?? '')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .reverse();
  for (const line of lines) {
    try {
      return JSON.parse(line);
    } catch {
      // Tools may emit warnings before the final JSON line.
    }
  }
  throw new Error('RECOVERY_TOOL_OUTPUT_INVALID');
}

function requiredEnv(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`RECOVERY_INPUT_REQUIRED:${name}`);
  return value;
}

function databaseName(uri) {
  const parsed = new URL(uri);
  return decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
}

function redisDatabase(uri) {
  const parsed = new URL(uri);
  const value = Number(parsed.pathname.replace(/^\/+/, '') || '0');
  if (!Number.isInteger(value) || value < 0 || value > 15) {
    throw new Error('RECOVERY_REDIS_DATABASE_INVALID');
  }
  return value;
}

function safeTargetHash(value) {
  return sha256(value).slice(0, 16);
}

function assertOutsideWorktree(path) {
  const resolved = resolve(path);
  const relativePath = relative(repositoryRoot, resolved);
  if (relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))) {
    throw new Error('RECOVERY_EVIDENCE_INSIDE_WORKTREE');
  }
  return resolved;
}

function assertIsolatedBucket(value) {
  if (typeof value !== 'string' || !value.startsWith('kb-s11-')) {
    throw new Error('RECOVERY_BUCKET_INVALID');
  }
  return value;
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

  exec(service, command, args = [], options = {}) {
    const envArgs = (options.envNames ?? []).flatMap((name) => ['-e', name]);
    return this.runner(
      'docker',
      ['compose', '-f', this.composeFile, 'exec', '-T', ...envArgs, service, command, ...args],
      {
        encoding: 'utf8',
        env: this.env,
        cwd: repositoryRoot,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
  }

  copyFrom(service, source, target) {
    return this.runner(
      'docker',
      ['compose', '-f', this.composeFile, 'cp', `${service}:${source}`, target],
      {
        encoding: 'utf8',
        env: this.env,
        cwd: repositoryRoot,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
  }

  copyTo(source, service, target) {
    return this.runner(
      'docker',
      ['compose', '-f', this.composeFile, 'cp', source, `${service}:${target}`],
      {
        encoding: 'utf8',
        env: this.env,
        cwd: repositoryRoot,
        maxBuffer: 4 * 1024 * 1024,
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

function requireSuccess(result, code) {
  if (result.status !== 0) throw new Error(code);
  return result;
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
    args: ['--uri', '$S11_RECOVERY_MONGO_SOURCE_URI', '--archive', input.archivePath, '--gzip'],
    env: input.env,
  };
}

export function buildPgDump(input) {
  assertIsolatedTarget(input.sourcePrefix, 'source');
  return {
    command: 'pg_dump',
    service: 'pgvector',
    args: ['--dbname', '$S11_RECOVERY_PG_SOURCE_URL', '--format=custom', '--file', input.dumpPath],
    env: input.env,
  };
}

export function buildMinioMirror(input) {
  assertIsolatedTarget(input.sourcePrefix, 'source');
  return {
    command: 'mc',
    service: 'minio',
    args: ['mirror', '--preserve', 'source/$S11_RECOVERY_S3_SOURCE_BUCKET', input.mirrorPath],
    env: input.env,
  };
}

export function buildRedisSnapshot(input) {
  assertIsolatedTarget(input.sourcePrefix, 'source');
  return {
    command: 'redis-cli',
    service: 'redis',
    args: ['-u', '$S11_RECOVERY_REDIS_SOURCE_URL', '--rdb', input.rdbPath],
    env: input.env,
  };
}

export function writeManifest(input) {
  const evidenceDir = assertOutsideWorktree(input.evidenceDir);
  mkdirSync(evidenceDir, { recursive: true });
  const path = join(evidenceDir, 'recovery-manifest.json');
  writeFileSync(path, `${JSON.stringify(input.manifest, null, 2)}\n`);
  return path;
}

export function writeRecoveryInputManifest(input) {
  const mediaDir = assertOutsideWorktree(input.mediaDir);
  const media = MEDIA_NAMES.map((name) => mediaEntry(mediaDir, name));
  const manifest = {
    schemaVersion: 1,
    changeIdHash: sha256(input.changeId).slice(0, 16),
    sourceTargetHash: safeTargetHash(input.sourcePrefix),
    restoreTargetHash: safeTargetHash(input.restorePrefix),
    media,
    tools: input.tools,
    createdAt: new Date().toISOString(),
  };
  const path = join(mediaDir, 'recovery-input-manifest.json');
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return { path, manifest };
}

export function verifyRecoveryInputManifest(input) {
  const manifestPath = join(input.mediaDir, 'recovery-input-manifest.json');
  if (!existsSync(manifestPath)) throw new Error('RECOVERY_MEDIA_MANIFEST_REQUIRED');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.changeIdHash !== sha256(input.changeId).slice(0, 16)) {
    throw new Error('RECOVERY_MEDIA_CHANGE_ID_MISMATCH');
  }
  if (input.sourcePrefix && manifest.sourceTargetHash !== safeTargetHash(input.sourcePrefix)) {
    throw new Error('RECOVERY_MEDIA_SOURCE_TARGET_MISMATCH');
  }
  if (input.restorePrefix && manifest.restoreTargetHash !== safeTargetHash(input.restorePrefix)) {
    throw new Error('RECOVERY_MEDIA_RESTORE_TARGET_MISMATCH');
  }
  const present = new Set((manifest.media ?? []).map((entry) => entry.name));
  for (const name of MEDIA_NAMES) {
    if (!present.has(name)) throw new Error(`RECOVERY_MEDIA_REQUIRED:${name}`);
  }
  for (const expected of manifest.media) {
    const actual = mediaEntry(input.mediaDir, expected.name);
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
      throw new Error(`RECOVERY_MEDIA_HASH_MISMATCH:${expected.name}`);
    }
  }
  return { path: manifestPath, manifest };
}

export function backupAll(input) {
  if (!input.sourcePrefix.startsWith('kb_s11_')) throw new Error('RECOVERY_SOURCE_PREFIX_INVALID');
  const sourceMongoDb = databaseName(requiredEnv(input.env, RECOVERY_ENV.mongoSource));
  assertIsolatedTarget(sourceMongoDb, 'source');
  const mediaDir = assertOutsideWorktree(input.mediaDir);
  mkdirSync(mediaDir, { recursive: true });
  if (MEDIA_NAMES.some((name) => existsSync(join(mediaDir, name)))) {
    throw new Error('RECOVERY_MEDIA_ALREADY_EXISTS');
  }
  const id = sha256(input.changeId).slice(0, 16);
  const temp = `/tmp/s11-recovery-${id}`;
  const envNames = Object.values(RECOVERY_ENV);
  requireSuccess(
    input.executor.exec(
      'mongo',
      'sh',
      [
        '-lc',
        `rm -rf "${temp}" && mkdir -p "${temp}/mongo-dump" && mongodump --uri "$S11_RECOVERY_MONGO_SOURCE_URI" --db="${sourceMongoDb}" --out="${temp}/mongo-dump" && tar -czf "${temp}/mongo.archive.gz" -C "${temp}/mongo-dump" .`,
      ],
      { envNames },
    ),
    'RECOVERY_MONGO_BACKUP_FAILED',
  );
  requireSuccess(
    input.executor.copyFrom('mongo', `${temp}/mongo.archive.gz`, join(mediaDir, MEDIA_NAMES[0])),
    'RECOVERY_MONGO_COPY_FAILED',
  );
  requireSuccess(
    input.executor.exec(
      'pgvector',
      'sh',
      [
        '-lc',
        `rm -rf "${temp}" && mkdir -p "${temp}" && pg_dump --dbname "$S11_RECOVERY_PG_SOURCE_URL" --format=custom --file="${temp}/postgres.dump"`,
      ],
      { envNames },
    ),
    'RECOVERY_PG_BACKUP_FAILED',
  );
  requireSuccess(
    input.executor.copyFrom('pgvector', `${temp}/postgres.dump`, join(mediaDir, MEDIA_NAMES[1])),
    'RECOVERY_PG_COPY_FAILED',
  );
  requireSuccess(
    input.executor.exec(
      'minio',
      'sh',
      [
        '-lc',
        [
          `rm -rf "${temp}"`,
          `mkdir -p "${temp}/minio" "${temp}/mc"`,
          `mc --config-dir "${temp}/mc" alias set recovery "$S11_RECOVERY_S3_ENDPOINT" "$S11_RECOVERY_S3_ACCESS_KEY" "$S11_RECOVERY_S3_SECRET_KEY" >/dev/null`,
          `mc --config-dir "${temp}/mc" mirror --preserve "recovery/$S11_RECOVERY_S3_SOURCE_BUCKET" "${temp}/minio" >/dev/null`,
        ].join(' && '),
      ],
      { envNames },
    ),
    'RECOVERY_MINIO_BACKUP_FAILED',
  );
  requireSuccess(
    input.executor.copyFrom('minio', `${temp}/minio`, join(mediaDir, MEDIA_NAMES[3])),
    'RECOVERY_MINIO_COPY_FAILED',
  );
  requireSuccess(
    input.executor.exec(
      'redis',
      'sh',
      [
        '-lc',
        `rm -rf "${temp}" && mkdir -p "${temp}" && redis-cli -u "$S11_RECOVERY_REDIS_SOURCE_URL" --rdb "${temp}/redis.rdb"`,
      ],
      { envNames },
    ),
    'RECOVERY_REDIS_BACKUP_FAILED',
  );
  requireSuccess(
    input.executor.copyFrom('redis', `${temp}/redis.rdb`, join(mediaDir, MEDIA_NAMES[2])),
    'RECOVERY_REDIS_COPY_FAILED',
  );
  return writeRecoveryInputManifest({
    mediaDir,
    changeId: input.changeId,
    sourcePrefix: input.sourcePrefix,
    restorePrefix: input.restorePrefix,
    tools: input.tools,
  });
}

export function restoreAll(input) {
  const env = input.env;
  const id = sha256(input.changeId).slice(0, 16);
  const temp = `/tmp/s11-recovery-${id}`;
  const sourceMongoDb = databaseName(requiredEnv(env, RECOVERY_ENV.mongoSource));
  const restoreMongoDb = databaseName(requiredEnv(env, RECOVERY_ENV.mongoRestore));
  assertIsolatedTarget(sourceMongoDb, 'source');
  assertIsolatedTarget(restoreMongoDb, 'restore');
  assertIsolatedBucket(requiredEnv(env, RECOVERY_ENV.s3SourceBucket));
  assertIsolatedBucket(requiredEnv(env, RECOVERY_ENV.s3RestoreBucket));
  const envNames = Object.values(RECOVERY_ENV);
  requireSuccess(
    input.executor.exec('mongo', 'sh', ['-lc', `rm -rf "${temp}" && mkdir -p "${temp}"`]),
    'RECOVERY_MONGO_TEMP_FAILED',
  );
  requireSuccess(
    input.executor.copyTo(
      join(input.mediaDir, MEDIA_NAMES[0]),
      'mongo',
      `${temp}/mongo.archive.gz`,
    ),
    'RECOVERY_MONGO_COPY_FAILED',
  );
  requireSuccess(
    input.executor.exec(
      'mongo',
      'sh',
      [
        '-lc',
        `mkdir -p "${temp}/mongo-restore" && tar -xzf "${temp}/mongo.archive.gz" -C "${temp}/mongo-restore" && mongorestore --uri "$S11_RECOVERY_MONGO_RESTORE_URI" --dir="${temp}/mongo-restore/${sourceMongoDb}" --drop --nsFrom="${sourceMongoDb}.*" --nsTo="${restoreMongoDb}.*"`,
      ],
      { envNames },
    ),
    'RECOVERY_MONGO_RESTORE_FAILED',
  );
  requireSuccess(
    input.executor.exec('pgvector', 'sh', ['-lc', `rm -rf "${temp}" && mkdir -p "${temp}"`]),
    'RECOVERY_PG_TEMP_FAILED',
  );
  requireSuccess(
    input.executor.copyTo(
      join(input.mediaDir, MEDIA_NAMES[1]),
      'pgvector',
      `${temp}/postgres.dump`,
    ),
    'RECOVERY_PG_COPY_FAILED',
  );
  requireSuccess(
    input.executor.exec(
      'pgvector',
      'sh',
      [
        '-lc',
        `pg_restore --dbname "$S11_RECOVERY_PG_RESTORE_URL" --clean --if-exists --no-owner --no-privileges "${temp}/postgres.dump"`,
      ],
      { envNames },
    ),
    'RECOVERY_PG_RESTORE_FAILED',
  );
  requireSuccess(
    input.executor.exec('minio', 'sh', ['-lc', `rm -rf "${temp}" && mkdir -p "${temp}"`]),
    'RECOVERY_MINIO_TEMP_FAILED',
  );
  requireSuccess(
    input.executor.copyTo(join(input.mediaDir, MEDIA_NAMES[3]), 'minio', `${temp}/minio`),
    'RECOVERY_MINIO_COPY_FAILED',
  );
  requireSuccess(
    input.executor.exec(
      'minio',
      'sh',
      [
        '-lc',
        [
          `mkdir -p "${temp}/mc"`,
          `mc --config-dir "${temp}/mc" alias set recovery "$S11_RECOVERY_S3_ENDPOINT" "$S11_RECOVERY_S3_ACCESS_KEY" "$S11_RECOVERY_S3_SECRET_KEY" >/dev/null`,
          `mc --config-dir "${temp}/mc" mb --ignore-existing "recovery/$S11_RECOVERY_S3_RESTORE_BUCKET" >/dev/null`,
          `mc --config-dir "${temp}/mc" mirror --overwrite --preserve "${temp}/minio" "recovery/$S11_RECOVERY_S3_RESTORE_BUCKET" >/dev/null`,
        ].join(' && '),
      ],
      { envNames },
    ),
    'RECOVERY_MINIO_RESTORE_FAILED',
  );
  const redisTarget = new URL(requiredEnv(env, RECOVERY_ENV.redisRestore));
  const redisSourceDb = redisDatabase(requiredEnv(env, RECOVERY_ENV.redisSource));
  const redisTargetDb = redisDatabase(redisTarget.toString());
  const migrateAuth = redisTarget.password
    ? redisTarget.username
      ? `AUTH2 ${decodeURIComponent(redisTarget.username)} ${decodeURIComponent(redisTarget.password)}`
      : `AUTH ${decodeURIComponent(redisTarget.password)}`
    : '';
  requireSuccess(
    input.executor.exec('redis', 'sh', ['-lc', `rm -rf "${temp}" && mkdir -p "${temp}/redis"`]),
    'RECOVERY_REDIS_TEMP_FAILED',
  );
  requireSuccess(
    input.executor.copyTo(join(input.mediaDir, MEDIA_NAMES[2]), 'redis', `${temp}/redis/dump.rdb`),
    'RECOVERY_REDIS_COPY_FAILED',
  );
  requireSuccess(
    input.executor.exec(
      'redis',
      'sh',
      [
        '-lc',
        [
          `redis-server --dir "${temp}/redis" --dbfilename dump.rdb --port 6389 --daemonize yes --save "" --appendonly no`,
          'sleep 1',
          `redis-cli -p 6389 -n ${redisSourceDb} --scan | while IFS= read -r key; do redis-cli -p 6389 -n ${redisSourceDb} MIGRATE ${redisTarget.hostname} ${redisTarget.port || '6379'} "$key" ${redisTargetDb} 5000 REPLACE ${migrateAuth} >/dev/null; done`,
          'redis-cli -p 6389 shutdown nosave',
        ].join(' && '),
      ],
      { envNames },
    ),
    'RECOVERY_REDIS_RESTORE_FAILED',
  );
}

function mongoStats(executor, envName) {
  const variable = `$${envName}`;
  const script = [
    'const out={collections:{},eventKeys:[],usageEventIds:[],duplicateEventKeys:[],duplicateUsageEventIds:[]};',
    'db.getCollectionNames().filter((name)=>name.startsWith("knowledge_")).sort().forEach((name)=>{out.collections[name]=db.getCollection(name).countDocuments({});});',
    'if(db.getCollectionNames().includes("knowledge_outbox_events")){out.eventKeys=db.knowledge_outbox_events.distinct("eventKey").slice(0,1000);}',
    'if(db.getCollectionNames().includes("knowledge_usage_events")){out.usageEventIds=db.knowledge_usage_events.distinct("eventId").slice(0,1000);}',
    'if(db.getCollectionNames().includes("knowledge_outbox_events")){out.duplicateEventKeys=db.knowledge_outbox_events.aggregate([{$group:{_id:"$eventKey",count:{$sum:1}}},{$match:{count:{$gt:1}}},{$project:{_id:0,value:"$_id"}}]).toArray().map((entry)=>entry.value);}',
    'if(db.getCollectionNames().includes("knowledge_usage_events")){out.duplicateUsageEventIds=db.knowledge_usage_events.aggregate([{$group:{_id:"$eventId",count:{$sum:1}}},{$match:{count:{$gt:1}}},{$project:{_id:0,value:"$_id"}}]).toArray().map((entry)=>entry.value);}',
    'print(JSON.stringify(out));',
  ].join('');
  const result = requireSuccess(
    executor.exec('mongo', 'sh', ['-lc', `mongosh "${variable}" --quiet --eval '${script}'`], {
      envNames: [envName],
    }),
    `RECOVERY_MONGO_STATS_FAILED:${envName}`,
  );
  return parseLastJson(result.stdout);
}

function ensureMongoCollections(executor, envName, collections) {
  if (collections.length === 0) return;
  const variable = `$${envName}`;
  const names = JSON.stringify(collections);
  const script = `const expected=${names};expected.forEach((name)=>{if(!db.getCollectionNames().includes(name))db.createCollection(name);});`;
  requireSuccess(
    executor.exec('mongo', 'sh', ['-lc', `mongosh "${variable}" --quiet --eval '${script}'`], {
      envNames: [envName],
    }),
    `RECOVERY_MONGO_ENSURE_COLLECTIONS_FAILED:${envName}`,
  );
}

function pgStats(executor, envName) {
  const variable = `$${envName}`;
  const query = [
    "SELECT 'knowledge_vector_profiles='||count(*) FROM knowledge_vector_profiles",
    "SELECT 'knowledge_segment_vectors_768='||count(*) FROM knowledge_segment_vectors_768",
    "SELECT 'knowledge_segment_vectors_1024='||count(*) FROM knowledge_segment_vectors_1024",
    "SELECT 'knowledge_segment_vectors_1536='||count(*) FROM knowledge_segment_vectors_1536",
    "SELECT 'knowledge_segment_vectors_3072='||count(*) FROM knowledge_segment_vectors_3072",
  ].join(' UNION ALL ');
  const result = requireSuccess(
    executor.exec('pgvector', 'sh', ['-lc', `psql "${variable}" -Atc "${query}"`], {
      envNames: [envName],
    }),
    `RECOVERY_PG_STATS_FAILED:${envName}`,
  );
  return Object.fromEntries(
    String(result.stdout)
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [name, count] = line.split('=');
        return [name, Number(count)];
      }),
  );
}

function redisStats(executor, envName) {
  const variable = `$${envName}`;
  const result = requireSuccess(
    executor.exec('redis', 'sh', ['-lc', `redis-cli -u "${variable}" DBSIZE`], {
      envNames: [envName],
    }),
    `RECOVERY_REDIS_STATS_FAILED:${envName}`,
  );
  return { keys: Number(String(result.stdout).trim()) };
}

function s3Stats(executor, envName) {
  const variable = `$${envName}`;
  const result = requireSuccess(
    executor.exec(
      'minio',
      'sh',
      [
        '-lc',
        [
          'mkdir -p /tmp/s11-recovery-mc',
          'mc --config-dir /tmp/s11-recovery-mc alias set recovery "$S11_RECOVERY_S3_ENDPOINT" "$S11_RECOVERY_S3_ACCESS_KEY" "$S11_RECOVERY_S3_SECRET_KEY" >/dev/null',
          `mc --config-dir /tmp/s11-recovery-mc ls --recursive "recovery/${variable}" | wc -l`,
        ].join(' && '),
      ],
      {
        envNames: [envName, RECOVERY_ENV.s3Endpoint, RECOVERY_ENV.s3Access, RECOVERY_ENV.s3Secret],
      },
    ),
    'RECOVERY_S3_STATS_FAILED',
  );
  return { objects: Number(String(result.stdout).trim().split(/\r?\n/).at(-1)) };
}

async function healthStatus(baseUrl) {
  const base = baseUrl.replace(/\/+$/, '');
  const [health, ready] = await Promise.all(
    ['healthz', 'readyz'].map(async (name) => {
      try {
        const response = await globalThis.fetch(`${base}/${name}`, {
          signal: globalThis.AbortSignal.timeout(10_000),
        });
        return response.status;
      } catch {
        return null;
      }
    }),
  );
  return { healthz: health, readyz: ready };
}

export async function executeRecovery(input, dependencies = {}) {
  const env = input.env;
  const mediaMode = env.S11_RECOVERY_MEDIA_MODE?.trim() || 'generate';
  if (!['generate', 'consume'].includes(mediaMode)) {
    throw new Error('RECOVERY_MEDIA_MODE_INVALID');
  }
  const evidenceDir = assertOutsideWorktree(requiredEnv(env, 'S11_EVIDENCE_DIR'));
  const mediaDir = assertOutsideWorktree(
    env.S11_RECOVERY_MEDIA_DIR?.trim() || join(evidenceDir, 'media'),
  );
  const changeId = requiredEnv(env, 'S11_RECOVERY_CHANGE_ID');
  const sourcePrefix = requiredEnv(env, 'S11_RECOVERY_SOURCE_PREFIX');
  const restorePrefix = requiredEnv(env, 'S11_RECOVERY_RESTORE_PREFIX');
  assertIsolatedTarget(sourcePrefix, 'source');
  assertIsolatedTarget(restorePrefix, 'restore');
  for (const name of Object.values(RECOVERY_ENV)) requiredEnv(env, name);
  const executor = input.executor;
  const tools = executor.probe();
  if (tools.status !== 'READY') throw new Error('RECOVERY_TOOL_UNAVAILABLE');
  mkdirSync(evidenceDir, { recursive: true });
  if (mediaMode === 'generate') {
    backupAll({
      executor,
      env,
      mediaDir,
      changeId,
      sourcePrefix,
      restorePrefix,
      tools,
    });
  } else {
    verifyRecoveryInputManifest({ mediaDir, changeId, sourcePrefix, restorePrefix });
  }
  const verifiedManifest = verifyRecoveryInputManifest({
    mediaDir,
    changeId,
    sourcePrefix,
    restorePrefix,
  });
  restoreAll({ executor, mediaDir, changeId, sourcePrefix, restorePrefix, env });
  const sourceMongo = mongoStats(executor, RECOVERY_ENV.mongoSource);
  ensureMongoCollections(executor, RECOVERY_ENV.mongoRestore, Object.keys(sourceMongo.collections));
  const restoreMongo = mongoStats(executor, RECOVERY_ENV.mongoRestore);
  const sourcePg = pgStats(executor, RECOVERY_ENV.pgSource);
  const restorePg = pgStats(executor, RECOVERY_ENV.pgRestore);
  const sourceRedis = redisStats(executor, RECOVERY_ENV.redisSource);
  const restoreRedis = redisStats(executor, RECOVERY_ENV.redisRestore);
  const sourceS3 = s3Stats(executor, RECOVERY_ENV.s3SourceBucket);
  const restoreS3 = s3Stats(executor, RECOVERY_ENV.s3RestoreBucket);
  const healthUrl = env.S11_RECOVERY_HEALTH_URL?.trim() || 'http://127.0.0.1:3010';
  const health = await (dependencies.healthStatus ?? healthStatus)(healthUrl);
  const beforeCounts = {
    ...Object.fromEntries(
      Object.entries(sourceMongo.collections).map(([name, count]) => [`mongo:${name}`, count]),
    ),
    ...Object.fromEntries(Object.entries(sourcePg).map(([name, count]) => [`pg:${name}`, count])),
    'redis:keys': sourceRedis.keys,
    'minio:objects': sourceS3.objects,
  };
  const afterCounts = {
    ...Object.fromEntries(
      Object.entries(restoreMongo.collections).map(([name, count]) => [`mongo:${name}`, count]),
    ),
    ...Object.fromEntries(Object.entries(restorePg).map(([name, count]) => [`pg:${name}`, count])),
    'redis:keys': restoreRedis.keys,
    'minio:objects': restoreS3.objects,
  };
  const vectors = Object.keys(restorePg)
    .filter((name) => name.startsWith('knowledge_segment_vectors_'))
    .map((name) => ({ vectorId: `${name}:aggregate` }));
  const minioFiles = walkFiles(join(mediaDir, 'minio'));
  const summary = normalizeRecovery({
    changeId,
    candidateSha: env.CANDIDATE_SHA ?? 'UNFROZEN',
    isolatedSource: sourcePrefix,
    isolatedRestore: restorePrefix,
    commands: [
      buildMongoDump({
        sourcePrefix,
        archivePath: '$S11_RECOVERY_MEDIA_DIR/mongo.archive.gz',
        env,
      }),
      buildPgDump({
        sourcePrefix,
        dumpPath: '$S11_RECOVERY_MEDIA_DIR/postgres.dump',
        env,
      }),
      buildMinioMirror({
        sourcePrefix,
        mirrorPath: '$S11_RECOVERY_MEDIA_DIR/minio',
        env,
      }),
      buildRedisSnapshot({
        sourcePrefix,
        rdbPath: '$S11_RECOVERY_MEDIA_DIR/redis.rdb',
        env,
      }),
    ].map(({ service, command, args }) => ({ service, command, args })),
    beforeCounts,
    afterCounts,
    eventIds: [
      ...restoreMongo.eventKeys.map((value) => `outbox:${value}`),
      ...restoreMongo.usageEventIds.map((value) => `usage:${value}`),
      ...restoreMongo.duplicateEventKeys.map((value) => `outbox:${value}`),
      ...restoreMongo.duplicateUsageEventIds.map((value) => `usage:${value}`),
    ],
    vectors,
    objects: minioFiles.map((file) => ({
      active: true,
      referenced: true,
      objectKeyHash: file.sha256,
    })),
    health,
    blockers: [],
  });
  const summaryPath = join(evidenceDir, 'recovery-summary.json');
  writeFileSync(
    summaryPath,
    `${JSON.stringify(
      {
        ...summary,
        mediaMode,
        inputManifestSha256: hashOfFile(verifiedManifest.path),
      },
      null,
      2,
    )}\n`,
  );
  writeManifest({
    evidenceDir,
    manifest: {
      schemaVersion: 1,
      status: summary.status,
      changeId,
      summaryPath,
      summarySha256: hashOfFile(summaryPath),
      mediaMode,
      inputManifestSha256: hashOfFile(verifiedManifest.path),
    },
  });
  return { summary, summaryPath };
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
  try {
    const result = await executeRecovery(
      {
        env: {
          ...env,
          S11_RECOVERY_SOURCE_PREFIX: sourcePrefix,
          S11_RECOVERY_RESTORE_PREFIX: restorePrefix,
        },
        executor,
      },
      dependencies,
    );
    console.log(
      JSON.stringify(
        {
          status: result.summary.status,
          summaryPath: result.summaryPath,
          changeId: result.summary.changeId,
          differences: result.summary.counts.differences,
          health: result.summary.health,
        },
        null,
        2,
      ),
    );
    if (result.summary.status === 'PASS') {
      console.log('RECOVERY_PASS');
      return 0;
    }
    console.error(`RECOVERY_${result.summary.status}`);
    return result.summary.status === 'SCOPED_BLOCKED' ? 4 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    return /INPUT_REQUIRED|MEDIA_REQUIRED|MEDIA_MANIFEST_REQUIRED|TOOL_UNAVAILABLE/.test(message)
      ? 4
      : 1;
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exit(await main());
}
