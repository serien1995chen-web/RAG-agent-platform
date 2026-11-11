import { randomUUID } from 'node:crypto';
import type { Connection } from 'mongoose';
import { FileTicketService } from '../../../sdk/storage/src';
import {
  KnowledgeAccessRepository,
  KnowledgeApplication,
  KnowledgeArchiveRepository,
  KnowledgeAuditRepository,
  KnowledgeCatalogRepository,
  KnowledgeObjectRefRepository,
  KnowledgeTagRepository,
  S7SearchAuthorizationAdapter,
} from '../../../packages/service/src/modules/knowledge';
import { FileApplication } from '../../../packages/service/src/modules/knowledge/application/file.application';
import { createKnowledgeMongoConnection } from '../../../packages/service/src/shared/runtime/knowledge-connections';
import type { Candidate, SearchHydrationResult } from '../../../packages/search/src';
import {
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../../packages/service/src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../../packages/service/src/shared/persistence/knowledge/tenant';

export interface B03BSpaceFixture {
  id: string;
  version: number;
  permissionRevision: number;
}

export interface B03BSourceFixture {
  id: string;
  version: number;
  permissionRevision: number;
  sourceVersion: number;
}

export interface B03BSearchFixture {
  space: B03BSpaceFixture;
  source: B03BSourceFixture;
  segmentId: string;
  candidate: Candidate;
}

export interface B03BHarness {
  suffix: string;
  connection: Connection;
  models: ReturnType<typeof registerKnowledgeModels>;
  catalog: KnowledgeCatalogRepository;
  access: KnowledgeAccessRepository;
  archive: KnowledgeArchiveRepository;
  objectRefs: KnowledgeObjectRefRepository;
  application: KnowledgeApplication;
  searchAuthorization: S7SearchAuthorizationAdapter;
  fileApplication: FileApplication;
  workspaceA: string;
  workspaceB: string;
  ownerA: TenantContext;
  managerA: TenantContext;
  readerA: TenantContext;
  ownerB: TenantContext;
  createSpace(
    context?: TenantContext,
    input?: {
      name?: string;
      accessMode?: 'workspace' | 'restricted';
      sourcePermissionEnabled?: boolean;
    },
  ): Promise<B03BSpaceFixture>;
  createSource(
    spaceId: string,
    context?: TenantContext,
    input?: { name?: string; searchEnabled?: boolean },
  ): Promise<B03BSourceFixture>;
  createSearchFixture(context?: TenantContext): Promise<B03BSearchFixture>;
  hydrate(candidate: Candidate, context: TenantContext): Promise<SearchHydrationResult>;
  createSourceObject(input: {
    spaceId: string;
    sourceId: string;
    context?: TenantContext;
  }): Promise<{ blobId: string }>;
  reset(): Promise<void>;
  cleanup(): Promise<void>;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required B03B test environment: ${name}`);
  return value;
}

function context(
  workspaceId: string,
  memberId: string,
  suffix: string,
  scopes: string[],
): TenantContext {
  return {
    workspaceId,
    memberId,
    requestId: `req_b03b_${memberId}_${suffix}`,
    traceId: `trace_b03b_${suffix}`.padEnd(32, '0').slice(0, 32),
    scopes,
  };
}

function fakeObjectStore() {
  return {
    provider: 'minio' as const,
    bucket: 'kb-test',
    async ensureBucket() {},
    async copyObjectImmutable() {
      throw new Error('unexpected copyObjectImmutable in B03B ticket test');
    },
    async headObject() {
      throw new Error('unexpected headObject in B03B ticket test');
    },
    async getObject() {
      return {
        body: (async function* () {})(),
        size: 1,
        etag: 'b03b-etag',
        contentType: 'application/octet-stream',
        contentRange: null,
      };
    },
    async presignPut() {
      throw new Error('unexpected presignPut in B03B ticket test');
    },
    async createMultipartUpload() {
      throw new Error('unexpected createMultipartUpload in B03B ticket test');
    },
    async uploadPart() {
      throw new Error('unexpected uploadPart in B03B ticket test');
    },
    async listParts() {
      return [];
    },
    async completeMultipartUpload() {
      throw new Error('unexpected completeMultipartUpload in B03B ticket test');
    },
    async abortMultipartUpload() {
      return { aborted: true };
    },
    async deleteObject() {
      return { deleted: true };
    },
  };
}

export async function openB03BHarness(seedSuffix?: string): Promise<B03BHarness> {
  const suffix = seedSuffix ?? randomUUID().replaceAll('-', '').slice(0, 12);
  const workspaceA = `ws_b03b_a_${suffix}`;
  const workspaceB = `ws_b03b_b_${suffix}`;
  const ownerA = context(workspaceA, `mem_b03b_owner_${suffix}`, suffix, [
    'knowledge:read',
    'knowledge:write',
    'knowledge:manage',
    'knowledge:search',
    'knowledge:admin',
  ]);
  const managerA = context(workspaceA, `mem_b03b_manager_${suffix}`, suffix, [
    'knowledge:read',
    'knowledge:write',
    'knowledge:manage',
    'knowledge:search',
  ]);
  const readerA = context(workspaceA, `mem_b03b_reader_${suffix}`, suffix, [
    'knowledge:read',
    'knowledge:search',
  ]);
  const ownerB = context(workspaceB, `mem_b03b_owner_b_${suffix}`, suffix, [
    'knowledge:read',
    'knowledge:write',
    'knowledge:manage',
    'knowledge:search',
  ]);

  const connection = await createKnowledgeMongoConnection(requiredEnv('KB_TEST_MONGO_URI'));
  await ensureKnowledgeCollections(connection);
  const models = registerKnowledgeModels(connection);
  const catalog = new KnowledgeCatalogRepository(connection);
  const access = new KnowledgeAccessRepository(connection);
  const archive = new KnowledgeArchiveRepository(connection);
  const objectRefs = new KnowledgeObjectRefRepository(connection);
  const audits = new KnowledgeAuditRepository(connection);
  const application = new KnowledgeApplication(
    catalog,
    new KnowledgeTagRepository(connection),
    access,
    archive,
    undefined,
    undefined,
    undefined,
    audits,
  );
  const searchAuthorization = new S7SearchAuthorizationAdapter(connection, access);
  const fileApplication = new FileApplication(
    objectRefs,
    fakeObjectStore(),
    catalog,
    access,
    new FileTicketService(`b03b-ticket-secret-${suffix}-at-least-32-bytes`, 'http://b03b.test'),
  );

  async function createSpace(
    ownerContext: TenantContext = ownerA,
    input: {
      name?: string;
      accessMode?: 'workspace' | 'restricted';
      sourcePermissionEnabled?: boolean;
    } = {},
  ): Promise<B03BSpaceFixture> {
    const created = await catalog.createSpace(
      {
        kind: 'space',
        name: input.name ?? `B03B space ${suffix}`,
        accessMode: input.accessMode ?? 'restricted',
        sourceAclMode: 'inherited',
        sourcePermissionEnabled: input.sourcePermissionEnabled ?? true,
      },
      ownerContext,
    );
    await access.ensureOwnerAcl(
      'space',
      created.id,
      ownerContext,
      (input.accessMode ?? 'restricted') === 'workspace'
        ? [
            {
              principalType: 'workspace',
              principalId: ownerContext.workspaceId,
              permission: 'read',
            },
          ]
        : [],
    );
    return {
      id: created.id,
      version: created.version,
      permissionRevision:
        (
          await models.KnowledgeSpace.findOne({
            workspaceId: ownerContext.workspaceId,
            _id: created.id,
          }).lean()
        )?.permissionRevision ?? 0,
    };
  }

  async function createSource(
    spaceId: string,
    ownerContext: TenantContext = ownerA,
    input: { name?: string; searchEnabled?: boolean } = {},
  ): Promise<B03BSourceFixture> {
    const created = await catalog.createSource(
      spaceId,
      {
        kind: 'text',
        name: input.name ?? `B03B source ${suffix}`,
        searchEnabled: input.searchEnabled ?? true,
      },
      ownerContext,
    );
    return {
      id: created.id,
      version: created.version,
      permissionRevision: Number(created.permissionRevision ?? 0),
      sourceVersion: Number(created.sourceVersion ?? 1),
    };
  }

  async function createSearchFixture(ownerContext: TenantContext = ownerA) {
    const space = await createSpace(ownerContext);
    const source = await createSource(space.id, ownerContext);
    const segment = await catalog.createSegment(
      source.id,
      {
        question: `B03B search question ${suffix}`,
        answer: `B03B search answer ${suffix}`,
        searchEnabled: true,
      },
      ownerContext,
    );
    await models.KnowledgeSegment.updateOne(
      {
        workspaceId: ownerContext.workspaceId,
        _id: segment.id,
      },
      {
        $set: {
          indexStatus: 'indexed',
          fullTextVersion: 1,
        },
      },
    );
    const candidate: Candidate = {
      docId: `${space.id}:${segment.id}`,
      segmentId: segment.id,
      sourceId: source.id,
      knowledgeSpaceId: space.id,
      score: 0.99,
      scores: [{ type: 'embedding', score: 0.99 }],
      text: `B03B search question ${suffix}`,
      fullTextVersion: 1,
    };
    return { space, source, segmentId: segment.id, candidate };
  }

  async function hydrate(candidate: Candidate, searchContext: TenantContext) {
    return searchAuthorization.hydrate([candidate], {
      workspaceId: searchContext.workspaceId,
      memberId: searchContext.memberId,
      requestId: searchContext.requestId,
      traceId: searchContext.traceId,
      scopes: [...searchContext.scopes],
      isWorkspaceOwner: searchContext.isWorkspaceOwner,
    });
  }

  async function createSourceObject(input: {
    spaceId: string;
    sourceId: string;
    context?: TenantContext;
  }) {
    const objectContext = input.context ?? ownerA;
    const blob = await models.KnowledgeObjectRef.create({
      workspaceId: objectContext.workspaceId,
      knowledgeSpaceId: input.spaceId,
      version: 1,
      deletedAt: null,
      createdByMemberId: objectContext.memberId,
      updatedByMemberId: objectContext.memberId,
      provider: 'minio',
      bucket: 'kb-test',
      objectKey: `ws/${objectContext.workspaceId}/source/${input.sourceId}/${suffix}.txt`,
      purpose: 'source',
      sourceId: input.sourceId,
      mimeType: 'text/plain',
      sizeBytes: 1,
      etag: 'b03b-etag',
      sha256: 'b03b-sha256',
      state: 'active',
      expiresAt: null,
      upload: { originalName: `${suffix}.txt` },
    });
    return { blobId: String(blob._id) };
  }

  async function reset() {
    for (const model of Object.values(models)) {
      await model.deleteMany({ workspaceId: { $in: [workspaceA, workspaceB] } });
    }
  }

  async function cleanup() {
    await reset();
    await connection.close();
  }

  return {
    suffix,
    connection,
    models,
    catalog,
    access,
    archive,
    objectRefs,
    application,
    searchAuthorization,
    fileApplication,
    workspaceA,
    workspaceB,
    ownerA,
    managerA,
    readerA,
    ownerB,
    createSpace,
    createSource,
    createSearchFixture,
    hydrate,
    createSourceObject,
    reset,
    cleanup,
  };
}

export function extendedContext(
  tenant: TenantContext,
  input: { groupIds?: string[]; orgIds?: string[] },
): TenantContext {
  return {
    ...tenant,
    ...input,
  } as TenantContext;
}
