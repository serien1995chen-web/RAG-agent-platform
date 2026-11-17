import { createHash, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KnowledgeCatalogRepository } from '../../src/modules/knowledge';
import type {
  S5ArtifactPutInput,
  S5ArtifactPutResult,
  S5ArtifactStorePort,
  S5ParseResult,
} from '../../src/modules/knowledge/application/s5-processing-ports';
import { S5ArtifactRepository } from '../../src/modules/knowledge/repository/s5-artifact.repository';
import { registerKnowledgeModels } from '../../src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_b11_artifact_${suffix}`;
const otherWorkspaceId = `ws_b11_artifact_other_${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId: `mem_b11_artifact_${suffix}`,
  requestId: `req_b11_artifact_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write'],
};

let connection: mongoose.Connection;
let catalog: KnowledgeCatalogRepository;

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

class RecordingStore implements S5ArtifactStorePort {
  readonly provider = 'minio' as const;
  readonly bucket = 'b11-private-bucket';
  readonly puts: S5ArtifactPutInput[] = [];

  constructor(private readonly failPurpose?: 'source' | 'image') {}

  async putObject(input: S5ArtifactPutInput): Promise<S5ArtifactPutResult> {
    this.puts.push(input);
    if (input.purpose === this.failPurpose) throw new Error('injected object storage failure');
    return {
      key: input.key,
      size: input.body.byteLength,
      etag: `etag-${this.puts.length}`,
      sha256: input.sha256,
    };
  }
}

function parseResult(rawText: string): S5ParseResult {
  const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const asset = {
    assetId: 'b11-image',
    mimeType: 'image/png',
    sha256: digest(image),
    sizeBytes: image.byteLength,
    bytes: image,
  };
  return {
    format: 'ofd',
    rawText,
    pages: [
      {
        pageNumber: 1,
        text: rawText,
        assets: [asset],
      },
    ],
    assets: [asset],
    diagnostics: [],
    scanRequired: false,
    imageRefs: ['b11/image.png'],
    contentHash: `sha256:${digest(rawText)}`,
    parserVersion: 'ofd-clean-room@1',
    configHash: `sha256:${digest('b11-config')}`,
  };
}

async function sourceFixture(name: string) {
  const space = await catalog.createSpace(
    {
      kind: 'space',
      name,
      accessMode: 'workspace',
      sourceAclMode: 'enforced',
      sourcePermissionEnabled: true,
    },
    context,
  );
  const source = await catalog.createSource(
    space.id,
    { kind: 'file', name: `${name}.ofd` },
    context,
  );
  return { space, source };
}

beforeAll(async () => {
  const uri = new URL(
    process.env.KB_TEST_MONGO_URI ?? 'mongodb://127.0.0.1:27017/kb_b11_artifact?replicaSet=rs0',
  );
  if (uri.hostname === '127.0.0.1' || uri.hostname === 'localhost') {
    uri.searchParams.set('directConnection', 'true');
  }
  connection = mongoose.createConnection(uri.toString(), { serverSelectionTimeoutMS: 5_000 });
  await connection.asPromise();
  catalog = new KnowledgeCatalogRepository(connection);
}, 60_000);

beforeEach(async () => {
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId: { $in: [workspaceId, otherWorkspaceId] } });
  }
});

afterAll(async () => {
  if (!connection) return;
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId: { $in: [workspaceId, otherWorkspaceId] } });
  }
  await connection.close();
});

describe('L1-B11-A PARSE-001 artifact persistence', () => {
  it('L1-B11-A-PARSE-001-S01 binds rawText and image refs to one Source version and is sequential-idempotent', async () => {
    const { space, source } = await sourceFixture(`Artifact ${suffix}`);
    const store = new RecordingStore();
    const repository = new S5ArtifactRepository(connection, store);
    const parse = parseResult('B11 artifact raw text');
    const input = {
      sourceId: source.id,
      sourceVersion: 1,
      knowledgeSpaceId: space.id,
      parse,
    };

    const first = await repository.materialize(input, context);
    const second = await repository.materialize(input, context);
    expect(second.rawTextObjectRef.blobId).toBe(first.rawTextObjectRef.blobId);
    expect(second.assets[0]?.objectRefId).toBe(first.assets[0]?.objectRefId);
    expect(store.puts.map((put) => put.purpose).sort()).toEqual(['image', 'source']);

    const models = registerKnowledgeModels(connection);
    const refs = await models.KnowledgeObjectRef.find({ workspaceId }).lean();
    expect(refs).toHaveLength(2);
    expect(refs.every((ref) => ref.state === 'active')).toBe(true);
    expect(refs.map((ref) => ref.purpose).sort()).toEqual(['image', 'source']);
    const persistedSource = await models.KnowledgeSource.findById(source.id).lean();
    expect(persistedSource?.contentHash).toBe(digest(parse.rawText));
    expect(persistedSource?.sourceVersion).toBe(1);
    expect(JSON.stringify(first.evidence)).not.toMatch(/bucket|objectKey|b11-private-bucket/i);
  });

  it('L1-B11-A-PARSE-001-S02 image upload failure leaves no active half-materialized artifact', async () => {
    const { space, source } = await sourceFixture(`Artifact failure ${suffix}`);
    const repository = new S5ArtifactRepository(connection, new RecordingStore('image'));
    const parse = parseResult('B11 partial artifact must not remain active');
    await expect(
      repository.materialize(
        {
          sourceId: source.id,
          sourceVersion: 1,
          knowledgeSpaceId: space.id,
          parse,
        },
        context,
      ),
    ).rejects.toThrow('injected object storage failure');

    const models = registerKnowledgeModels(connection);
    const refs = await models.KnowledgeObjectRef.find({ workspaceId }).lean();
    expect(refs.filter((ref) => ref.state === 'active')).toEqual([]);
    const persistedSource = await models.KnowledgeSource.findById(source.id).lean();
    expect(persistedSource?.contentHash).not.toBe(digest(parse.rawText));
  });

  it('L1-B11-A-PARSE-001-C01 concurrent materialization of the same Source version yields one active pair', async () => {
    const { space, source } = await sourceFixture(`Artifact concurrency ${suffix}`);
    const store = new RecordingStore();
    const repository = new S5ArtifactRepository(connection, store);
    const parse = parseResult('B11 concurrent artifact');
    const input = {
      sourceId: source.id,
      sourceVersion: 1,
      knowledgeSpaceId: space.id,
      parse,
    };

    const outcomes = await Promise.allSettled([
      repository.materialize(input, context),
      repository.materialize(input, context),
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
    const models = registerKnowledgeModels(connection);
    const refs = await models.KnowledgeObjectRef.find({ workspaceId }).lean();
    expect(refs.filter((ref) => ref.state === 'active')).toHaveLength(2);
  });

  it('L1-B11-A-PARSE-001-A01 cross-tenant artifact materialization fails closed', async () => {
    const { space, source } = await sourceFixture(`Artifact tenant ${suffix}`);
    const repository = new S5ArtifactRepository(connection, new RecordingStore());
    const otherContext = {
      ...context,
      workspaceId: otherWorkspaceId,
      memberId: `other_member_${suffix}`,
    };
    await expect(
      repository.materialize(
        {
          sourceId: source.id,
          sourceVersion: 1,
          knowledgeSpaceId: space.id,
          parse: parseResult('must stay hidden'),
        },
        otherContext,
      ),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } } });
    expect(
      await registerKnowledgeModels(connection).KnowledgeObjectRef.countDocuments({
        workspaceId: otherWorkspaceId,
      }),
    ).toBe(0);
  });
});
