import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S5MockModelCatalog } from '../../src/modules/knowledge/adapter/s5-aiproxy-catalog.adapter';
import { S7SearchRepository } from '../../src/modules/knowledge/repository/s7-search.repository';
import {
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';
// @ts-expect-error The S11 performance fixture is a repository-local JavaScript helper.
import { seedSegments } from '../../../../test/performance/prepare-fixtures.mjs';

const segmentCount = 1_000_000;
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s11_b14_${suffix}`;
const knowledgeSpaceId = new mongoose.Types.ObjectId();
const context: TenantContext = {
  workspaceId,
  memberId: `mem_s11_b14_${suffix}`,
  requestId: `req_s11_b14_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:search'],
};
const database =
  process.env.KB_B14_PERF_DATABASE?.trim() || `kb_s11_b14_perf_${suffix.toLowerCase()}`;
const resultDir = process.env.B14_RESULT_DIR?.trim() || join(process.cwd(), 'test-results', 'b14');

let connection: mongoose.Connection;
let search: S7SearchRepository;

function mongoUriForDatabase(uriValue: string, databaseName: string) {
  const uri = new URL(uriValue);
  uri.pathname = `/${databaseName}`;
  if (uri.hostname === '127.0.0.1' || uri.hostname === 'localhost') {
    uri.searchParams.set('directConnection', 'true');
  }
  return uri.toString();
}

function percentile(values: number[], ratio: number) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * ratio) - 1)] ?? 0;
}

beforeAll(async () => {
  if (!database.startsWith('kb_s11_')) {
    throw new Error('B14 performance database must use the isolated kb_s11_ prefix');
  }
  const uri = mongoUriForDatabase(
    process.env.KB_TEST_MONGO_URI ??
      'mongodb://127.0.0.1:27017/kb_test?replicaSet=rs0&directConnection=true',
    database,
  );
  connection = mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5_000 });
  await connection.asPromise();
  await ensureKnowledgeCollections(connection);
  await connection.dropDatabase();
  await ensureKnowledgeCollections(connection);
  seedSegments({
    database,
    workspaceId,
    spaceId: String(knowledgeSpaceId),
    segmentCount,
    env: process.env,
  });
  search = new S7SearchRepository(connection, new S5MockModelCatalog());
}, 20 * 60_000);

afterAll(async () => {
  if (connection) {
    await connection.dropDatabase();
    await connection.close();
  }
}, 120_000);

describe('B14 TRAIN-004 1M Segment full-text performance', () => {
  it(
    'L1-B14-TRAIN-004-Q01 keeps full-text p95 at or below 900ms',
    async () => {
      const models = registerKnowledgeModels(connection);
      expect(
        await models.KnowledgeSegment.countDocuments({
          workspaceId,
          knowledgeSpaceId,
        }),
      ).toBe(segmentCount);
      const indexes = await models.KnowledgeSegment.collection.indexes();
      const fullTextIndex = indexes.find((index) => index.name === 'ix_segment_fulltext');
      expect(fullTextIndex).toMatchObject({
        key: { _fts: 'text', _ftsx: 1 },
        weights: { fullTextTokens: 1, question: 4, answer: 2, content: 2 },
        default_language: 'none',
      });

      const latencyMs: number[] = [];
      for (let attempt = 0; attempt < 53; attempt += 1) {
        const startedAt = performance.now();
        const hits = await search.fullTextRecall(
          {
            knowledgeSpaceId: String(knowledgeSpaceId),
            text: attempt % 3 === 0 ? 'release evidence' : 'performance query',
            limit: 100,
            options: { timeoutMs: 5_000 },
          },
          context,
        );
        latencyMs.push(performance.now() - startedAt);
        expect(hits.length).toBeGreaterThan(0);
      }
      const measured = latencyMs.slice(3);
      const p50 = percentile(measured, 0.5);
      const p95 = percentile(measured, 0.95);
      const output = {
        testId: 'L1-B14-TRAIN-004-Q01',
        status: p95 <= 900 ? 'PASS' : 'FAIL',
        candidateSha: process.env.KB_B14_CANDIDATE_SHA ?? null,
        segmentCount,
        samples: measured.length,
        p50Ms: Number(p50.toFixed(3)),
        p95Ms: Number(p95.toFixed(3)),
        thresholdMs: 900,
        hardware: {
          cpu: cpus()[0]?.model ?? 'UNKNOWN',
          logicalCpus: cpus().length,
          memoryBytes: totalmem(),
          platform: process.platform,
          node: process.version,
          mongo: '5.0.32',
        },
        index: fullTextIndex,
      };
      await mkdir(resultDir, { recursive: true });
      await writeFile(
        join(resultDir, 'train-004-1m-performance.json'),
        `${JSON.stringify(output, null, 2)}\n`,
      );
      expect(p95).toBeLessThanOrEqual(900);
    },
    20 * 60_000,
  );
});
