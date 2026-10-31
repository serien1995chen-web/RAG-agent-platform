import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { S10OperationsRepository } from '../../src/modules/knowledge/repository/s10-operations.repository';
import { KnowledgeAuditRepository } from '../../src/shared/persistence/knowledge/audit';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';
import {
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../src/shared/persistence/schemas/knowledge-index';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s10_audit_${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId: `member_s10_audit_${suffix}`,
  requestId: `request_s10_audit_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  apiKeyId: `65f1e5b2a1c9d4b7e8f0${suffix.slice(0, 4)}`,
  apiKeyPrefix: 'kn_live_test',
  ipHash: 'a'.repeat(64),
  userAgentHash: 'b'.repeat(64),
  scopes: ['knowledge:admin'],
};

let connection: mongoose.Connection;
let audits: KnowledgeAuditRepository;
let operations: S10OperationsRepository;

beforeAll(async () => {
  const value = process.env.KB_TEST_MONGO_URI?.trim();
  if (!value) throw new Error('missing required test environment: KB_TEST_MONGO_URI');
  const uri = new URL(value);
  if (uri.hostname === '127.0.0.1' || uri.hostname === 'localhost') {
    uri.searchParams.set('directConnection', 'true');
  }
  connection = mongoose.createConnection(uri.toString(), { serverSelectionTimeoutMS: 5_000 });
  await connection.asPromise();
  await ensureKnowledgeCollections(connection);
  audits = new KnowledgeAuditRepository(connection);
  operations = new S10OperationsRepository(connection, { enqueue: async () => ({}) } as never);
}, 60_000);

beforeEach(async () => {
  await registerKnowledgeModels(connection).KnowledgeAuditEvent.deleteMany({ workspaceId });
});

afterAll(async () => {
  if (!connection) return;
  await registerKnowledgeModels(connection).KnowledgeAuditEvent.deleteMany({ workspaceId });
  await connection.close();
});

describe('TEST-OPS-003-BLOCK audit query and append-only guard', () => {
  it('stores safe request identity, supports filters and never mutates audit documents', async () => {
    for (let index = 0; index < 2; index += 1) {
      await audits.appendStandalone(
        {
          knowledgeSpaceId: null,
          action: 'api_key.create',
          resourceType: 'api_key',
          resourceId: `65f1e5b2a1c9d4b7e8f0123${index}`,
          outcome: 'succeeded',
          safeDiff: {
            keyPrefix: 'kn_live_test',
            promptVersion: 's10.audit.v1',
            secret: 'must-not-be-stored',
            body: 'private content',
            ip: '203.0.113.10',
          },
        },
        context,
      );
    }
    const first = await operations.list(
      { action: 'api_key.create', outcome: 'succeeded', limit: 1 },
      context,
    );
    expect(first.items).toHaveLength(1);
    expect(first.pageInfo.hasMore).toBe(true);
    expect(first.pageInfo.nextCursor).toBeTruthy();
    expect(first.items[0]).toMatchObject({
      apiKeyId: context.apiKeyId,
      apiKeyPrefix: context.apiKeyPrefix,
      ipHash: context.ipHash,
      userAgentHash: context.userAgentHash,
      safeDiff: {
        keyPrefix: 'kn_live_test',
        promptVersion: 's10.audit.v1',
        secret: '[REDACTED]',
        body: '[REDACTED]',
        ip: '[REDACTED]',
      },
    });
    const second = await operations.list(
      { action: 'api_key.create', limit: 1, cursor: first.pageInfo.nextCursor ?? undefined },
      context,
    );
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.eventId).not.toBe(first.items[0]?.eventId);
    await expect(audits.update()).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_FORBIDDEN' } },
    });
    await expect(audits.delete()).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_FORBIDDEN' } },
    });
  });
});
