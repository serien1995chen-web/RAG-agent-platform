import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  B19_B_RUN_ID,
  B19_B_SHORT_CODE,
  b19bTenantContext,
  mongoUriForRun,
  writeB19BEvidence,
} from '../../../../test/fixtures/b19-b/support';
import { S10OperationApplication } from '../../src/modules/knowledge/application/operations/s10-operations';
import { KnowledgeCatalogRepository } from '../../src/modules/knowledge/repository/catalog.repository';
import { S10OperationsRepository } from '../../src/modules/knowledge/repository/s10-operations.repository';
import { KnowledgeTagRepository } from '../../src/modules/knowledge/repository/tag.repository';
import { KnowledgeAuditRepository } from '../../src/shared/persistence/knowledge/audit';
import {
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../src/shared/persistence/schemas/knowledge-index';

const requiredWorkspace = `b19-b-audit-${B19_B_RUN_ID}`.slice(0, 64);
const foreignWorkspace = `b19-b-audit-foreign-${B19_B_RUN_ID}`.slice(0, 64);
const owner = b19bTenantContext('owner', requiredWorkspace);

let connection: mongoose.Connection;
let catalog: KnowledgeCatalogRepository;
let tags: KnowledgeTagRepository;
let audits: KnowledgeAuditRepository;
let operations: S10OperationsRepository;
let application: S10OperationApplication;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

async function cleanup(): Promise<void> {
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId: { $in: [requiredWorkspace, foreignWorkspace] } });
  }
}

beforeAll(async () => {
  connection = mongoose.createConnection(mongoUriForRun(requiredEnv('KB_TEST_MONGO_URI')), {
    serverSelectionTimeoutMS: 5_000,
  });
  await connection.asPromise();
  await ensureKnowledgeCollections(connection);
  catalog = new KnowledgeCatalogRepository(connection);
  tags = new KnowledgeTagRepository(connection);
  audits = new KnowledgeAuditRepository(connection);
  operations = new S10OperationsRepository(connection, { enqueue: async () => ({}) } as never);
  application = new S10OperationApplication({
    apiKeys: {} as never,
    usage: {} as never,
    audits: operations,
    ops: operations,
    catalog,
    hmacSecret: `b19-b-audit-${B19_B_RUN_ID}`,
  });
}, 60_000);

beforeEach(cleanup);

afterAll(async () => {
  if (!connection) return;
  const remaining = await cleanup();
  await writeB19BEvidence('audit-cleanup.json', {
    workspaceIds: [requiredWorkspace, foreignWorkspace],
    remaining: remaining ?? null,
  });
  await connection.close();
});

describe('L1-B19-OPS-003 audit event matrix', () => {
  it('L1-B19-OPS-003-P01 records create/update events for Space, Directory and Source', async () => {
    const space = await catalog.createSpace(
      {
        kind: 'space',
        name: `Audit Space ${B19_B_RUN_ID}`,
        accessMode: 'workspace',
        sourceAclMode: 'inherited',
        sourcePermissionEnabled: true,
      },
      owner,
    );
    const updatedSpace = await catalog.updateSpace(
      space.id,
      { version: space.version, name: `Audit Space Updated ${B19_B_RUN_ID}` },
      owner,
    );
    const directory = await catalog.createDirectory(
      space.id,
      { name: `Audit Directory ${B19_B_RUN_ID}` },
      owner,
    );
    const updatedDirectory = await catalog.updateDirectory(
      directory.id,
      { version: directory.version, name: `Audit Directory Updated ${B19_B_RUN_ID}` },
      owner,
    );
    const source = await catalog.createSource(
      space.id,
      {
        kind: 'text',
        name: `Audit Source ${B19_B_RUN_ID}`,
        directoryId: directory.id,
      },
      owner,
    );
    const updatedSource = await catalog.updateSource(
      source.id,
      { version: source.version, name: `Audit Source Updated ${B19_B_RUN_ID}` },
      owner,
    );
    const tag = await tags.create(
      space.id,
      {
        key: `audit_tag_${B19_B_SHORT_CODE}`,
        label: `Audit Tag ${B19_B_RUN_ID}`,
        tagType: 'string',
        options: ['a', 'b'],
      },
      owner,
    );
    const updatedTag = await tags.update(
      tag.id,
      { version: tag.version, label: `Audit Tag Updated ${B19_B_RUN_ID}` },
      owner,
    );
    await tags.delete(tag.id, owner);

    const events = await registerKnowledgeModels(connection)
      .KnowledgeAuditEvent.find({
        workspaceId: requiredWorkspace,
      })
      .sort({ occurredAt: 1, _id: 1 })
      .lean();
    const actions = events.map((event) => event.action);
    await writeB19BEvidence('audit-event-matrix.json', {
      runId: B19_B_RUN_ID,
      workspaceId: requiredWorkspace,
      resources: {
        space: { id: space.id, versionBefore: space.version, versionAfter: updatedSpace.version },
        directory: {
          id: directory.id,
          versionBefore: directory.version,
          versionAfter: updatedDirectory.version,
        },
        source: {
          id: source.id,
          versionBefore: source.version,
          versionAfter: updatedSource.version,
        },
        tag: { id: tag.id, versionBefore: tag.version, versionAfter: updatedTag.version },
      },
      expectedActions: [
        'space.create',
        'space.update',
        'directory.create',
        'directory.update',
        'source.create',
        'source.update',
        'tag.create',
        'tag.update',
        'tag.delete',
      ],
      actualActions: actions,
      events: events.map((event) => ({
        eventId: event.eventId,
        action: event.action,
        resourceType: event.resourceType,
        resourceId: String(event.resourceId),
        outcome: event.outcome,
        requestId: event.requestId,
        traceId: event.traceId,
        occurredAt: event.occurredAt.toISOString(),
        safeDiff: event.safeDiff,
      })),
    });
    expect(actions).toEqual(
      expect.arrayContaining([
        'space.create',
        'space.update',
        'directory.create',
        'directory.update',
        'source.create',
        'source.update',
        'tag.create',
        'tag.update',
        'tag.delete',
      ]),
    );
    expect(new Set(events.map((event) => event.eventId)).size).toBe(events.length);
    for (const event of events) {
      expect(event).toMatchObject({
        workspaceId: requiredWorkspace,
        actorMemberId: owner.memberId,
        requestId: owner.requestId,
        traceId: owner.traceId,
        ipHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        userAgentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(event.occurredAt).toBeInstanceOf(Date);
    }
  });

  it('L1-B19-OPS-003-N01 rejects unknown action filters', async () => {
    const unknownAction = application.dispatch({
      operationId: 'API-AUDIT-LIST',
      params: {},
      query: { action: `unknown-${B19_B_RUN_ID}` },
      body: {},
      context: owner,
    });
    await expect(unknownAction).rejects.toMatchObject({
      problem: {
        error: {
          code: 'KNOWLEDGE_VALIDATION_FAILED',
          details: { field: 'action' },
        },
      },
    });
  });

  it('L1-B19-OPS-003-N01 rejects unknown resourceType filters', async () => {
    const unknownResource = application.dispatch({
      operationId: 'API-AUDIT-LIST',
      params: {},
      query: { resourceType: `unknown-${B19_B_RUN_ID}` },
      body: {},
      context: owner,
    });
    await expect(unknownResource).rejects.toMatchObject({
      problem: {
        error: {
          code: 'KNOWLEDGE_VALIDATION_FAILED',
          details: { field: 'resourceType' },
        },
      },
    });
  });

  it('L1-B19-OPS-003-N01 hides expired TTL records', async () => {
    const now = new Date();
    await registerKnowledgeModels(connection).KnowledgeAuditEvent.create({
      workspaceId: requiredWorkspace,
      knowledgeSpaceId: null,
      version: 1,
      deletedAt: null,
      createdByMemberId: owner.memberId,
      updatedByMemberId: owner.memberId,
      eventId: `${B19_B_RUN_ID}-expired`,
      action: 'cleanup.queued',
      actorMemberId: owner.memberId,
      apiKeyId: null,
      apiKeyPrefix: null,
      resourceType: 'job',
      resourceId: 'b19-b-expired-resource',
      outcome: 'succeeded',
      traceId: owner.traceId,
      requestId: owner.requestId,
      ipHash: owner.ipHash,
      userAgentHash: owner.userAgentHash,
      safeDiff: {},
      occurredAt: new Date(now.getTime() - 3 * 86_400_000),
      expiresAt: new Date(now.getTime() - 86_400_000),
    });
    const page = await operations.list(
      { action: 'cleanup.queued', from: new Date(now.getTime() - 4 * 86_400_000) },
      owner,
    );
    expect(page.items).toEqual([]);
  });

  it('L1-B19-OPS-003-S01/Q01 keeps append-only guards and removes sensitive values', async () => {
    await audits.appendStandalone(
      {
        knowledgeSpaceId: null,
        action: 'source.create',
        resourceType: 'source',
        resourceId: 'b19-b-safe-source',
        outcome: 'succeeded',
        safeDiff: {
          authorization: 'Bearer private-token',
          cookie: 'session=private-cookie',
          objectKey: `b19-b/${B19_B_RUN_ID}/private`,
          prompt: 'private prompt',
          body: 'private body',
          ip: '203.0.113.10',
          userAgent: 'raw-agent',
          keyPrefix: 'kn_live_safe',
          version: 3,
        },
      },
      owner,
    );
    const page = await operations.list({ action: 'source.create' }, owner);
    expect(page.items).toHaveLength(1);
    const serialized = JSON.stringify(page.items);
    expect(serialized).not.toContain('private-token');
    expect(serialized).not.toContain('private-cookie');
    expect(serialized).not.toContain(`b19-b/${B19_B_RUN_ID}/private`);
    expect(serialized).not.toContain('private prompt');
    expect(serialized).not.toContain('private body');
    expect(serialized).not.toContain('203.0.113.10');
    expect(serialized).not.toContain('raw-agent');
    expect(page.items[0]?.safeDiff).toMatchObject({ keyPrefix: 'kn_live_safe', version: 3 });
    await expect(audits.update()).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_FORBIDDEN' } },
    });
    await expect(audits.delete()).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_FORBIDDEN' } },
    });
  });

  it('L1-B19-OPS-003-F01 fails closed when the audit store is unavailable', async () => {
    const model = registerKnowledgeModels(connection).KnowledgeAuditEvent;
    const create = vi
      .spyOn(model, 'create')
      .mockRejectedValueOnce(new Error('audit store unavailable'));
    await expect(
      audits.appendStandalone(
        {
          knowledgeSpaceId: null,
          action: 'source.create',
          resourceType: 'source',
          resourceId: 'b19-b-unavailable-audit-store',
          outcome: 'succeeded',
          safeDiff: { version: 1 },
        },
        owner,
      ),
    ).rejects.toBeDefined();
    create.mockRestore();
  });

  it('rolls back catalog writes when transactional audit append is unavailable', async () => {
    const space = await catalog.createSpace(
      {
        kind: 'space',
        name: `Audit Rollback ${B19_B_RUN_ID}`,
        accessMode: 'workspace',
        sourceAclMode: 'inherited',
        sourcePermissionEnabled: true,
      },
      owner,
    );
    const model = registerKnowledgeModels(connection).KnowledgeAuditEvent;
    const create = vi
      .spyOn(model, 'create')
      .mockRejectedValueOnce(new Error('audit transaction unavailable'));
    await expect(
      catalog.updateSpace(
        space.id,
        { version: space.version, name: `Audit Rollback Updated ${B19_B_RUN_ID}` },
        owner,
      ),
    ).rejects.toBeDefined();
    create.mockRestore();
    const persisted = await catalog.getSpace(space.id, owner);
    expect(persisted).toMatchObject({ version: space.version, name: space.name });
  });
});
