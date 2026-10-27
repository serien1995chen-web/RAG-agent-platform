import { randomUUID } from 'node:crypto';
import mongoose, { type Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthorizedCandidate } from '@kb/search';
import { S7CitationApplication } from '../../src/modules/knowledge/application/s7-citation.application';
import { S7CitationSigner } from '../../src/modules/knowledge/adapter/s7-citation-signer';
import { S7SearchAuthorizationAdapter } from '../../src/modules/knowledge/adapter/s7-search-authorization.adapter';
import { KnowledgeAccessRepository } from '../../src/modules/knowledge/repository/access.repository';
import { S7CitationRepository } from '../../src/modules/knowledge/repository/s7-citation.repository';
import {
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s7_citation_${suffix}`;
const memberId = `mem_s7_citation_${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId,
  requestId: `req-s7-citation-${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:search'],
};
const now = new Date('2026-10-27T00:00:00Z');
const secret = '0123456789abcdef0123456789abcdef';

let connection: mongoose.Connection;
let spaceId: Types.ObjectId;
let sourceId: Types.ObjectId;
let segmentId: Types.ObjectId;
let access: KnowledgeAccessRepository;
let authorization: S7SearchAuthorizationAdapter;
let citations: S7CitationRepository;
let application: S7CitationApplication;

async function seed() {
  const models = registerKnowledgeModels(connection);
  const space = await models.KnowledgeSpace.create({
    workspaceId,
    knowledgeSpaceId: null,
    version: 1,
    deletedAt: null,
    createdByMemberId: memberId,
    updatedByMemberId: memberId,
    kind: 'space',
    parentSpaceId: null,
    name: `Citations ${suffix}`,
    normalizedName: `citations-${suffix}`,
    description: '',
    iconKey: 'search',
    ownershipMemberId: `owner-${suffix}`,
    accessMode: 'workspace',
    sourceAclMode: 'enforced',
    sourcePermissionEnabled: true,
    referenceRevision: 0,
    permissionRevision: 1,
    modelBindings: {},
    defaultChunking: {},
    status: 'active',
  });
  spaceId = space._id;
  const source = await models.KnowledgeSource.create({
    workspaceId,
    knowledgeSpaceId: spaceId,
    version: 1,
    deletedAt: null,
    createdByMemberId: memberId,
    updatedByMemberId: memberId,
    directoryId: null,
    kind: 'text',
    name: 'Refund policy',
    externalId: null,
    connectorId: null,
    blobRefId: null,
    originalUrl: 'https://example.invalid/refund',
    mimeType: 'text/plain',
    sizeBytes: 30,
    contentHash: 'citation-hash',
    parseProvider: 'liteparse',
    processingStatus: 'ready',
    sourceVersion: 1,
    searchEnabled: true,
    permissionState: 'disabled',
    permissionRevision: 1,
    ownershipMemberId: `owner-${suffix}`,
    metadata: {},
    tagValues: [],
  });
  sourceId = source._id;
  const segment = await models.KnowledgeSegment.create({
    workspaceId,
    knowledgeSpaceId: spaceId,
    version: 1,
    deletedAt: null,
    createdByMemberId: memberId,
    updatedByMemberId: memberId,
    sourceId,
    searchEnabled: true,
    order: 0,
    question: 'How long does a refund take?',
    answer: 'Five business days.',
    content: 'Refunds are processed within five business days.',
    fullTextTokens: 'refund five business days',
    metadata: {},
    history: [],
    indexes: [],
    indexStatus: 'indexed',
    indexErrorCode: null,
    imageBlobRefId: null,
    imageDescription: null,
    synonymVersion: 0,
  });
  segmentId = segment._id;
  await models.KnowledgeResourcePermission.create({
    workspaceId,
    knowledgeSpaceId: spaceId,
    version: 1,
    deletedAt: null,
    createdByMemberId: memberId,
    updatedByMemberId: memberId,
    resourceType: 'space',
    resourceId: spaceId,
    principalType: 'member',
    principalId: memberId,
    permission: 'read',
    inheritMode: 'override',
    snapshotVersion: 1,
  });
}

function candidate(): AuthorizedCandidate {
  const text =
    'How long does a refund take?\nFive business days.\nRefunds are processed within five business days.';
  return {
    docId: `${String(spaceId)}:${String(segmentId)}`,
    segmentId: String(segmentId),
    sourceId: String(sourceId),
    knowledgeSpaceId: String(spaceId),
    score: 0.8,
    embeddingScore: 0.8,
    scores: [],
    text,
    citationRange: { start: 0, end: [...text].length },
    segment: {
      id: String(segmentId),
      workspaceId,
      knowledgeSpaceId: String(spaceId),
      sourceId: String(sourceId),
      order: 0,
      searchEnabled: true,
      question: 'How long does a refund take?',
      answer: 'Five business days.',
      content: text,
      metadata: {},
      indexes: [],
      indexStatus: 'indexed',
      indexErrorCode: null,
      imageBlobRefId: null,
      version: 1,
    },
    source: {
      id: String(sourceId),
      workspaceId,
      knowledgeSpaceId: String(spaceId),
      name: 'Refund policy',
      originalUrl: 'https://example.invalid/refund',
      sourceVersion: 1,
      permissionRevision: 1,
      searchEnabled: true,
      deletedAt: null,
    },
  };
}

beforeAll(async () => {
  const uri = new URL(requiredEnv('KB_TEST_MONGO_URI'));
  if (uri.hostname === '127.0.0.1' || uri.hostname === 'localhost') {
    uri.searchParams.set('directConnection', 'true');
  }
  connection = mongoose.createConnection(uri.toString(), { serverSelectionTimeoutMS: 5_000 });
  await connection.asPromise();
  await ensureKnowledgeCollections(connection);
  access = new KnowledgeAccessRepository(connection);
  authorization = new S7SearchAuthorizationAdapter(connection, access);
  const signer = new S7CitationSigner(secret);
  citations = new S7CitationRepository(connection, signer);
  application = new S7CitationApplication({
    access: authorization,
    authorizations: authorization,
    citations,
    signer,
    now: () => now,
  });
}, 60_000);

beforeEach(async () => {
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId });
  }
  await seed();
});

afterAll(async () => {
  if (!connection) return;
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId });
  }
  await connection.close();
});

describe('TEST-SEARCH-009-BLOCK real Mongo citation lifecycle', () => {
  it('issues citation and audit atomically, reads with ACL, and leaves audit unchanged', async () => {
    const issued = await citations.issueWithAudit(
      {
        searchId: 'search_citation_integration',
        searchMode: 'semantic',
        spaceId: String(spaceId),
        candidates: [candidate()],
        partial: false,
        durationMs: 10,
        degradedCodes: [],
        now,
      },
      context,
    );
    expect(issued.size).toBe(1);
    const models = registerKnowledgeModels(connection);
    const citation = await models.KnowledgeCitation.findOne({ workspaceId });
    expect(citation).not.toBeNull();
    expect(citation?.expiresAt.toISOString()).toBe(
      new Date(now.getTime() + 24 * 86_400_000).toISOString(),
    );
    expect(await models.KnowledgeAuditEvent.countDocuments({ workspaceId })).toBe(1);
    const indexes = await connection.db!.collection('knowledge_citations').indexes();
    expect(indexes).toContainEqual(
      expect.objectContaining({
        name: 'ttl_citation',
        expireAfterSeconds: 0,
      }),
    );

    const read = await application.get(citation!.citationId, context);
    expect(read).toMatchObject({
      citationId: citation!.citationId,
      segmentId: String(segmentId),
      sourceId: String(sourceId),
      sourceUrl: 'https://example.invalid/refund',
    });
    expect(await models.KnowledgeAuditEvent.countDocuments({ workspaceId })).toBe(1);
  });

  it('returns not found after content or ACL changes', async () => {
    const issued = await citations.issueWithAudit(
      {
        searchId: 'search_citation_change',
        searchMode: 'semantic',
        spaceId: String(spaceId),
        candidates: [candidate()],
        partial: false,
        durationMs: 10,
        degradedCodes: [],
        now,
      },
      context,
    );
    const citationId = [...issued.values()][0]!.citationId;
    const models = registerKnowledgeModels(connection);
    await models.KnowledgeSegment.updateOne(
      { workspaceId, _id: segmentId },
      { $set: { content: 'Changed content.' }, $inc: { version: 1 } },
    );
    await expect(application.get(citationId, context)).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });

    await models.KnowledgeSegment.updateOne(
      { workspaceId, _id: segmentId },
      {
        $set: { content: 'Refunds are processed within five business days.' },
        $inc: { version: -1 },
      },
    );
    await models.KnowledgeResourcePermission.deleteMany({
      workspaceId,
      resourceType: 'space',
      resourceId: spaceId,
    });
    await expect(application.get(citationId, context)).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
  });
});
