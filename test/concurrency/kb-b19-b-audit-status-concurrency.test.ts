import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  B19_B_RUN_ID,
  b19bTenantContext,
  mongoUriForRun,
  writeB19BEvidence,
} from '../fixtures/b19-b/support';
import { S10StatusApplication } from '../../packages/service/src/modules/knowledge/application/s10-status.application';
import { S10OperationsRepository } from '../../packages/service/src/modules/knowledge/repository/s10-operations.repository';
import { KnowledgeAuditRepository } from '../../packages/service/src/shared/persistence/knowledge/audit';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';
import {
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../packages/service/src/shared/persistence/schemas/knowledge-index';

const workspaceId = `b19-b-concurrency-${B19_B_RUN_ID}`.slice(0, 64);
const context = b19bTenantContext('concurrency', workspaceId);
let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
let audits: KnowledgeAuditRepository;
let operations: S10OperationsRepository;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

async function cleanup(): Promise<void> {
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId });
  }
}

beforeAll(async () => {
  connection = await createKnowledgeMongoConnection(
    mongoUriForRun(requiredEnv('KB_TEST_MONGO_URI')),
  );
  await ensureKnowledgeCollections(connection);
  audits = new KnowledgeAuditRepository(connection);
  operations = new S10OperationsRepository(connection, { enqueue: async () => ({}) } as never);
}, 60_000);

beforeEach(cleanup);

afterAll(async () => {
  if (!connection) return;
  await cleanup();
  await writeB19BEvidence('concurrency-cleanup.json', { workspaceId });
  await connection.close();
});

describe('L1-B19-OPS-003-C01 audit concurrency', () => {
  it('keeps event IDs unique and pagination complete under concurrent append', async () => {
    await Promise.all(
      Array.from({ length: 32 }, async (_, index) => {
        await audits.appendStandalone(
          {
            knowledgeSpaceId: null,
            action: index % 2 === 0 ? 'connector.sync' : 'knowledge.search',
            resourceType: index % 2 === 0 ? 'connector' : 'workspace',
            resourceId: `b19-b-concurrent-${index}`,
            outcome: 'succeeded',
            safeDiff: { index, runId: B19_B_RUN_ID },
          },
          {
            ...context,
            requestId: `${context.requestId}-${index}`,
            traceId: `${context.traceId.slice(0, 29)}${String(index).padStart(3, '0')}`,
          },
        );
      }),
    );
    const raw = await registerKnowledgeModels(connection)
      .KnowledgeAuditEvent.find({
        workspaceId,
      })
      .lean();
    expect(raw).toHaveLength(32);
    expect(new Set(raw.map((event) => event.eventId)).size).toBe(32);

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await operations.list({ limit: 7, ...(cursor ? { cursor } : {}) }, context);
      expect(page.items.length).toBeLessThanOrEqual(7);
      seen.push(...page.items.map((item) => item.eventId));
      cursor = page.pageInfo.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toHaveLength(32);
    expect(new Set(seen).size).toBe(32);
    expect(seen).toEqual(
      await operations
        .list({ limit: 100 }, context)
        .then((page) => page.items.map((item) => item.eventId)),
    );
  });
});

describe('L1-B19-OPS-005-C01 status query concurrency', () => {
  it('does not mutate status-related collections during concurrent reads', async () => {
    const models = registerKnowledgeModels(connection);
    const before = Object.fromEntries(
      await Promise.all(
        Object.entries(models).map(async ([name, model]) => [
          name,
          await model.countDocuments({ workspaceId }),
        ]),
      ),
    );
    const view = {
      status: 'degraded' as const,
      queueDepth: {},
      queueLag: {},
      storage: {
        provider: 'minio' as const,
        healthy: true,
        verificationStatus: 'REAL_VERIFIED' as const,
      },
      vector: {
        backend: 'pgvector' as const,
        healthy: true,
        profiles: [768, 1024, 1536, 3072],
        verificationStatus: 'REAL_VERIFIED' as const,
      },
      dependencies: {
        mongo: {
          status: 'ok' as const,
          latencyMs: 1,
          verificationStatus: 'REAL_VERIFIED' as const,
        },
        redis: {
          status: 'ok' as const,
          latencyMs: 1,
          verificationStatus: 'REAL_VERIFIED' as const,
        },
        postgres: {
          status: 'ok' as const,
          latencyMs: 1,
          verificationStatus: 'REAL_VERIFIED' as const,
        },
        s3: { status: 'ok' as const, latencyMs: 1, verificationStatus: 'REAL_VERIFIED' as const },
      },
      modelProbe: {
        status: 'fixture_verified',
        verificationStatus: 'FIXTURE_VERIFIED' as const,
        latencyMs: 1,
      },
      connectorProbes: [],
      queueProbe: {
        status: 'ok' as const,
        latencyMs: 1,
        verificationStatus: 'REAL_VERIFIED' as const,
      },
      connectorProbe: {
        status: 'ok' as const,
        latencyMs: 1,
        verificationStatus: 'REAL_VERIFIED' as const,
      },
      securityChecks: {
        apiKeyHmacConfigured: true,
        scopeEnforced: true,
        auditAppendOnly: true,
        secretRedactionEnabled: true,
        rateLimitEnabled: true,
      },
      reconciliation: {
        lastRunAt: null,
        state: 'unknown' as const,
        orphanObjects: 0,
        orphanVectors: 0,
        diffCount: 0,
        repairedCount: 0,
      },
    };
    const status = new S10StatusApplication({ probe: async () => view });
    const results = await Promise.all(Array.from({ length: 32 }, () => status.get(context)));
    expect(results.every((result) => result.status === 'degraded')).toBe(true);
    const after = Object.fromEntries(
      await Promise.all(
        Object.entries(models).map(async ([name, model]) => [
          name,
          await model.countDocuments({ workspaceId }),
        ]),
      ),
    );
    expect(after).toEqual(before);
  });
});
