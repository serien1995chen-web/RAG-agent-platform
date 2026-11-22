#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

const runId = process.env.B19_RUN_ID?.trim() || 'b19-a-20261122-220039-7c1e';
const evidenceDir =
  process.env.B19_EVIDENCE_DIR?.trim() ||
  join('/home/serien/RAG-agent-platform/test-results/b19-a', runId);
const shortCode = runId.split('-').at(-1);
const mongoDatabase = `kb_test_b19a_${shortCode}`;
const bucket = process.env.B19_OBJECT_BUCKET?.trim() || `b19-a-${shortCode}`;

function docker(container, args) {
  const result = spawnSync('docker', ['exec', container, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return {
    exitCode: result.status ?? 1,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
}

const mongoScript = `
const target = db.getSiblingDB(${JSON.stringify(mongoDatabase)});
const collections = target.getCollectionNames();
const before = Object.fromEntries(collections.map((name) => [name, target.getCollection(name).countDocuments({})]));
target.dropDatabase();
const afterCount = target.getCollectionNames().length;
print(JSON.stringify({ before, afterCollectionCount: afterCount }));
`;
const mongoBefore = docker('rag-agent-platform-mongo-1', [
  'mongosh',
  '--quiet',
  '--eval',
  mongoScript,
]);

const redisBefore = docker('rag-agent-platform-redis-1', ['redis-cli', '-n', '15', 'DBSIZE']);
docker('rag-agent-platform-redis-1', ['redis-cli', '-n', '15', 'FLUSHDB']);
const redisAfter = docker('rag-agent-platform-redis-1', ['redis-cli', '-n', '15', 'DBSIZE']);

const objectBefore = docker('rag-agent-platform-minio-1', [
  'mc',
  'alias',
  'set',
  'b19local',
  'http://127.0.0.1:9000',
  process.env.MINIO_ROOT_USER ?? 'minioadmin',
  process.env.MINIO_ROOT_PASSWORD ?? 'minioadmin',
]);
const objectListBefore = docker('rag-agent-platform-minio-1', ['mc', 'ls', `b19local/${bucket}`]);
docker('rag-agent-platform-minio-1', ['mc', 'rm', '--recursive', '--force', `b19local/${bucket}`]);
docker('rag-agent-platform-minio-1', ['mc', 'rb', '--force', `b19local/${bucket}`]);
const objectListAfter = docker('rag-agent-platform-minio-1', ['mc', 'ls', `b19local/${bucket}`]);

const parsedMongo = JSON.parse(mongoBefore.stdout || '{}');
const cleanup = {
  runId,
  mongo: {
    database: mongoDatabase,
    beforeDocumentCounts: parsedMongo.before ?? {},
    afterCollectionCount: parsedMongo.afterCollectionCount ?? null,
    commandExitCode: mongoBefore.exitCode,
  },
  redis: {
    database: 15,
    beforeKeyCount: Number(redisBefore.stdout || 0),
    afterKeyCount: Number(redisAfter.stdout || 0),
    commandExitCodes: [redisBefore.exitCode, redisAfter.exitCode],
  },
  objectStorage: {
    bucket,
    aliasExitCode: objectBefore.exitCode,
    beforeListExitCode: objectListBefore.exitCode,
    afterListExitCode: objectListAfter.exitCode,
    afterRemoved: objectListAfter.exitCode !== 0 || objectListAfter.stdout.length === 0,
  },
  status:
    parsedMongo.afterCollectionCount === 0 &&
    Number(redisAfter.stdout || 0) === 0 &&
    (objectListAfter.exitCode !== 0 || objectListAfter.stdout.length === 0)
      ? 'PASS'
      : 'FAIL',
};
writeFileSync(join(evidenceDir, 'cleanup-final.json'), `${JSON.stringify(cleanup, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(cleanup, null, 2)}\n`);
if (cleanup.status !== 'PASS') process.exitCode = 1;
