import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KnowledgeCredentialCipher } from '../../src/modules/knowledge/adapter/credential-cipher';
import { KnowledgeConnectorRepository } from '../../src/modules/knowledge/repository/connector.repository';
import {
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s4_connector_${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId: `mem_s4_connector_${suffix}`,
  requestId: `req_s4_connector_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage'],
};

let connection: mongoose.Connection;
let repository: KnowledgeConnectorRepository;
let spaceId: string;

async function createSpace() {
  const document = await connection.models.KnowledgeSpace.create({
    workspaceId,
    knowledgeSpaceId: null,
    version: 1,
    deletedAt: null,
    createdByMemberId: context.memberId,
    updatedByMemberId: context.memberId,
    kind: 'space',
    parentSpaceId: null,
    name: `Connector ${randomUUID()}`,
    normalizedName: `connector-${randomUUID()}`,
    description: '',
    iconKey: 'book-open',
    ownershipMemberId: context.memberId,
    accessMode: 'workspace',
    sourceAclMode: 'enforced',
    sourcePermissionEnabled: true,
    referenceRevision: 0,
    permissionRevision: 0,
    modelBindings: {},
    defaultChunking: {},
    status: 'active',
  });
  return String(document._id);
}

beforeAll(async () => {
  const uri = new URL(
    process.env.KB_TEST_MONGO_URI ??
      `mongodb://127.0.0.1:27017/kb_s4_connector_${suffix}?replicaSet=rs0&directConnection=true`,
  );
  connection = mongoose.createConnection(uri.toString(), {
    serverSelectionTimeoutMS: 5_000,
  });
  await connection.asPromise();
  await ensureKnowledgeCollections(connection);
  repository = new KnowledgeConnectorRepository(
    connection,
    new KnowledgeCredentialCipher('c'.repeat(32)),
  );
}, 60_000);

beforeEach(async () => {
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId });
  }
  spaceId = await createSpace();
});

afterAll(async () => {
  if (!connection) return;
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId });
  }
  await connection.close();
});

describe('TEST-ING-007-BLOCK connector state', () => {
  it('stores encrypted credentials and only exposes redacted metadata', async () => {
    const connected = await repository.connect(
      spaceId,
      {
        provider: 'feishu',
        name: 'Feishu Support',
        credentials: {
          provider: 'feishu',
          appId: 'app-id',
          appSecret: 'must-not-leak',
        },
        config: { provider: 'feishu', folderToken: 'safe-token' },
        syncEnabled: true,
        syncIntervalMinutes: 60,
      },
      context,
    );
    expect(connected.credentialMetadata).toMatchObject({
      provider: 'feishu',
      schemaVersion: 1,
      keyVersion: 1,
      configured: true,
      redactedFields: ['appSecret'],
    });
    expect(JSON.stringify(connected)).not.toContain('must-not-leak');
    const document = await connection.models.KnowledgeConnector.findOne({
      _id: connected.id,
      workspaceId,
    }).lean();
    expect(document?.credentialCiphertext).not.toContain('must-not-leak');
    expect(await repository.decryptCredentials(connected.id, context)).toMatchObject({
      appSecret: 'must-not-leak',
    });
  });

  it('uses CAS update and submits sync without advancing cursor', async () => {
    const connected = await repository.connect(
      spaceId,
      {
        provider: 'feishu',
        name: 'Feishu Support',
        credentials: { provider: 'feishu', appId: 'id', appSecret: 'secret' },
        config: { provider: 'feishu', folderToken: 'safe-token' },
        syncEnabled: true,
        syncIntervalMinutes: 60,
      },
      context,
    );
    const updated = await repository.update(
      {
        connectorId: connected.id,
        version: connected.version,
        name: 'Renamed',
        syncEnabled: false,
      },
      context,
    );
    expect(updated.status).toBe('paused');
    expect(updated.nextSyncAt).toBeNull();
    await expect(
      repository.update(
        { connectorId: connected.id, version: connected.version, name: 'Stale' },
        context,
      ),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_CONFLICT' } } });

    const enabled = await repository.update(
      { connectorId: connected.id, version: updated.version, syncEnabled: true },
      context,
    );
    const sync = await repository.markSyncing(
      connected.id,
      { full: false, requestHash: 'sync-hash' },
      context,
    );
    expect(sync.job.kind).toBe('sync');
    expect(sync.connector.status).toBe('syncing');
    expect(sync.connector.cursorVersion).toBe(enabled.cursorVersion);
    const outbox = await connection.models.KnowledgeOutboxEvent.find({ workspaceId }).lean();
    expect(outbox.some((event) => event.eventType === 'connector.sync')).toBe(true);
  });

  it('erases credentials and propagates Source delete jobs', async () => {
    const connected = await repository.connect(
      spaceId,
      {
        provider: 'yuque',
        name: 'Yuque',
        credentials: { provider: 'yuque', userId: 'u1', token: 'token' },
        config: { provider: 'yuque' },
        syncEnabled: true,
        syncIntervalMinutes: 60,
      },
      context,
    );
    const source = await connection.models.KnowledgeSource.create({
      workspaceId,
      knowledgeSpaceId: new mongoose.Types.ObjectId(spaceId),
      version: 1,
      deletedAt: null,
      createdByMemberId: context.memberId,
      updatedByMemberId: context.memberId,
      kind: 'yuque',
      name: 'Doc',
      externalId: 'repo/doc',
      connectorId: new mongoose.Types.ObjectId(connected.id),
      mimeType: 'text/markdown',
      sizeBytes: 1,
      contentHash: 'hash',
      ownershipMemberId: context.memberId,
      metadata: {},
      tagValues: [],
    });
    const deleted = await repository.delete(connected.id, connected.version, context);
    expect(deleted.status).toBe('accepted');
    const connector = await connection.models.KnowledgeConnector.findById(connected.id).lean();
    expect(connector).toMatchObject({ status: 'deleted', credentialCiphertext: 'ERASED' });
    const jobs = await connection.models.KnowledgeJob.find({ workspaceId, kind: 'delete' }).lean();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.resourceId).toBe(String(source._id));
    expect(
      (await connection.models.KnowledgeSource.findById(source._id).lean())?.processingStatus,
    ).toBe('deleting');
  });
});
