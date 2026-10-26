import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  KnowledgeAccessRepository,
  KnowledgeApplication,
  KnowledgeArchiveRepository,
  KnowledgeCatalogRepository,
  KnowledgeReferenceRepository,
  KnowledgeTagRepository,
} from '../../src/modules/knowledge';
import {
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s3_${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId: `mem_s3_${suffix}`,
  requestId: `req_s3_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage', 'knowledge:admin'],
};

let connection: mongoose.Connection;
let catalog: KnowledgeCatalogRepository;
let references: KnowledgeReferenceRepository;
let application: KnowledgeApplication;

async function run(input: {
  operationId: string;
  params?: Record<string, string>;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  context?: TenantContext;
}) {
  return application.dispatch({
    operationId: input.operationId,
    params: input.params ?? {},
    query: input.query ?? {},
    headers: input.headers ?? {},
    body: input.body ?? {},
    context: input.context ?? context,
  });
}

async function space(name: string) {
  return (
    await run({
      operationId: 'API-SPACE-CREATE',
      body: {
        kind: 'space',
        name,
        accessMode: 'workspace',
        sourceAclMode: 'enforced',
        sourcePermissionEnabled: true,
      },
    })
  ).data as { id: string; version: number; referenceRevision: number };
}

async function folder(name: string) {
  return (
    await run({
      operationId: 'API-SPACE-CREATE',
      body: {
        kind: 'folder',
        name,
        accessMode: 'workspace',
        sourceAclMode: 'inherited',
        sourcePermissionEnabled: true,
      },
    })
  ).data as { id: string; version: number };
}

beforeAll(async () => {
  const uri = new URL(process.env.KB_TEST_MONGO_URI ?? 'mongodb://127.0.0.1:27017/kb_s3');
  if (uri.hostname === '127.0.0.1' || uri.hostname === 'localhost') {
    uri.searchParams.set('directConnection', 'true');
  }
  connection = mongoose.createConnection(uri.toString(), { serverSelectionTimeoutMS: 5_000 });
  await connection.asPromise();
  await ensureKnowledgeCollections(connection);
  catalog = new KnowledgeCatalogRepository(connection);
  references = new KnowledgeReferenceRepository(connection);
  application = new KnowledgeApplication(
    catalog,
    new KnowledgeTagRepository(connection),
    new KnowledgeAccessRepository(connection),
    new KnowledgeArchiveRepository(connection),
    undefined,
    undefined,
    references,
  );
}, 60_000);

beforeEach(async () => {
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId });
  }
});

afterAll(async () => {
  if (!connection) return;
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId });
  }
  await connection.close();
});

describe('TEST-KB-003-BLOCK catalog governance', () => {
  it('moves Space, Directory subtree and Source with CAS and parentPath', async () => {
    const destination = await folder(`Destination ${suffix}`);
    const targetSpace = await space(`Space ${suffix}`);
    const movedSpace = (
      await run({
        operationId: 'API-SPACE-MOVE',
        params: { spaceId: targetSpace.id },
        body: { targetParentId: destination.id, version: targetSpace.version },
      })
    ).data as { version: number; parentPath: string[] };
    expect(movedSpace.parentPath).toEqual([destination.id]);
    expect(movedSpace.version).toBe(targetSpace.version + 1);

    const parent = (
      await run({
        operationId: 'API-DIRECTORY-CREATE',
        params: { spaceId: targetSpace.id },
        body: { name: `Parent ${suffix}` },
      })
    ).data as { id: string; version: number };
    const child = (
      await run({
        operationId: 'API-DIRECTORY-CREATE',
        params: { spaceId: targetSpace.id },
        body: { name: `Child ${suffix}`, parentDirectoryId: parent.id },
      })
    ).data as { id: string; version: number; depth: number };
    const destinationDirectory = (
      await run({
        operationId: 'API-DIRECTORY-CREATE',
        params: { spaceId: targetSpace.id },
        body: { name: `Destination ${suffix}` },
      })
    ).data as { id: string; version: number };
    const movedDirectory = (
      await run({
        operationId: 'API-DIRECTORY-MOVE',
        params: { directoryId: parent.id },
        body: {
          targetParentId: destinationDirectory.id,
          version: parent.version,
        },
      })
    ).data as { version: number; parentPath: string[] };
    expect(movedDirectory.parentPath).toEqual([destinationDirectory.id]);
    const childAfter = await catalog.getDirectory(child.id, context);
    expect(childAfter.depth).toBe(2);

    const source = (
      await run({
        operationId: 'API-SOURCE-CREATE',
        params: { spaceId: targetSpace.id },
        body: { kind: 'text', name: `Source ${suffix}` },
      })
    ).data as { id: string; version: number };
    const movedSource = (
      await run({
        operationId: 'API-SOURCE-MOVE',
        params: { sourceId: source.id },
        body: { targetParentId: destinationDirectory.id, version: source.version },
      })
    ).data as { version: number; parentPath: string[]; directoryId: string };
    expect(movedSource.parentPath).toEqual([destinationDirectory.id]);
    expect(movedSource.directoryId).toBe(destinationDirectory.id);
  });

  it('returns 207 for a mixed batch and keeps successful items committed', async () => {
    const first = await space(`Batch A ${suffix}`);
    const second = await space(`Batch B ${suffix}`);
    const destination = await folder(`Batch folder ${suffix}`);
    const result = (
      await run({
        operationId: 'API-SPACE-BATCH',
        body: {
          action: 'move',
          ids: [first.id, second.id],
          targetParentId: destination.id,
          versions: { [first.id]: first.version, [second.id]: second.version + 1 },
        },
      })
    ).data as {
      code?: string;
      succeeded: number;
      failed: number;
      items: Array<{ id: string; success: boolean; code?: string }>;
    };
    expect(result.code).toBe('KNOWLEDGE_PARTIAL_SUCCESS');
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.items[1]).toMatchObject({
      id: second.id,
      success: false,
      code: 'KNOWLEDGE_CONFLICT',
    });
    expect((await catalog.getSpace(first.id, context)).parentSpaceId).toBe(destination.id);
  });

  it('blocks active references until the registry removes them with a newer revision', async () => {
    const target = await space(`Reference ${suffix}`);
    await references.applyUpsert(
      {
        spaceId: target.id,
        referrerType: 'app',
        referrerId: `app_${suffix}`,
        referrerVersion: 'v1',
        referrerName: 'Reference app',
        registryRevision: 1,
      },
      context,
    );
    const current = await catalog.getSpace(target.id, context);
    await expect(
      run({
        operationId: 'API-SPACE-DELETE',
        params: { spaceId: target.id },
        body: {
          version: current.version,
          expectedReferenceRevision: current.referenceRevision,
          referenceStrategy: 'detach',
        },
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_REFERENCE_CONFLICT' } },
    });
    await references.applyRemove(
      {
        spaceId: target.id,
        referrerType: 'app',
        referrerId: `app_${suffix}`,
        referrerVersion: 'v1',
        registryRevision: 2,
      },
      context,
    );
    const released = await catalog.getSpace(target.id, context);
    const deleted = await run({
      operationId: 'API-SPACE-DELETE',
      params: { spaceId: target.id },
      body: {
        version: released.version,
        expectedReferenceRevision: released.referenceRevision,
        referenceStrategy: 'block',
      },
    });
    expect(deleted.status).toBe(202);
    const auditCount = await connection.models.KnowledgeAuditEvent.countDocuments({
      workspaceId,
      action: {
        $in: ['space.move', 'directory.move', 'source.move', 'reference.upsert', 'space.delete'],
      },
    });
    expect(auditCount).toBeGreaterThan(0);
  });
});
