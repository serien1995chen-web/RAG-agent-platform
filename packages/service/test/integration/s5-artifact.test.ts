import { createHash, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KnowledgeCatalogRepository } from '../../src/modules/knowledge';
import type {
  S5ArtifactPutInput,
  S5ArtifactPutResult,
  S5ArtifactStorePort,
  S5ParseResult,
  S5ProcessingResult,
} from '../../src/modules/knowledge/application/s5-processing-ports';
import { S5ArtifactRepository } from '../../src/modules/knowledge/repository/s5-artifact.repository';
import { registerKnowledgeModels } from '../../src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s5_artifact_${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId: `mem_s5_artifact_${suffix}`,
  requestId: `req_s5_artifact_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write'],
};

function digest(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

class FakeStore implements S5ArtifactStorePort {
  readonly provider = 'minio' as const;
  readonly bucket = 'fake-bucket';
  readonly puts: S5ArtifactPutInput[] = [];

  async putObject(input: S5ArtifactPutInput): Promise<S5ArtifactPutResult> {
    this.puts.push(input);
    return {
      key: input.key,
      size: input.body.byteLength,
      etag: `etag-${this.puts.length}`,
      sha256: input.sha256,
    };
  }
}

class FailingStore extends FakeStore {
  override async putObject(input: S5ArtifactPutInput): Promise<S5ArtifactPutResult> {
    this.puts.push(input);
    throw new Error('object store unavailable');
  }
}

function parseResult(rawText: string): S5ParseResult {
  const assetBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const asset = {
    assetId: 'image-1',
    mimeType: 'image/png',
    sha256: digest(assetBytes),
    sizeBytes: assetBytes.byteLength,
    bytes: assetBytes,
  };
  return {
    format: 'ofd',
    rawText,
    pages: [{ pageNumber: 1, text: rawText, assets: [asset] }],
    assets: [asset],
    diagnostics: [{ severity: 'info', code: 'page_order_stable' }],
    scanRequired: false,
    imageRefs: ['Doc_0/Res/Page_0/image.png'],
    contentHash: `sha256:${digest(rawText)}`,
    parserVersion: 'ofd-clean-room@1',
    configHash: `sha256:${digest('ofd-config')}`,
  };
}

let connection: mongoose.Connection;
let catalog: KnowledgeCatalogRepository;

beforeAll(async () => {
  const uri = new URL(process.env.KB_TEST_MONGO_URI ?? 'mongodb://127.0.0.1:27017/kb_s5_artifact');
  if (uri.hostname === '127.0.0.1' || uri.hostname === 'localhost') {
    uri.searchParams.set('directConnection', 'true');
  }
  connection = mongoose.createConnection(uri.toString(), { serverSelectionTimeoutMS: 5_000 });
  await connection.asPromise();
  catalog = new KnowledgeCatalogRepository(connection);
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

describe('TEST-PARSE-001-BLOCK rawText and image ObjectRef materialization', () => {
  it('materializes purpose=source and purpose=image without changing sourceVersion', async () => {
    const { space, source } = await sourceFixture(`Artifact ${suffix}`);
    const store = new FakeStore();
    const repository = new S5ArtifactRepository(connection, store);
    const parse = parseResult('OFD page one');
    const first = await repository.materialize(
      {
        sourceId: source.id,
        sourceVersion: 1,
        knowledgeSpaceId: space.id,
        parse,
      },
      context,
    );
    expect(first.rawTextObjectRef.purpose).toBe('source');
    expect(first.assets).toHaveLength(1);
    expect(first.assets[0]?.objectRefId).toMatch(/^[a-f0-9]{24}$/);
    expect(first.evidence).toMatchObject({
      parserName: 'ofd',
      parserVersion: 'ofd-clean-room@1',
      rawTextHash: `sha256:${digest(parse.rawText)}`,
    });
    expect(store.puts.map((entry) => entry.purpose).sort()).toEqual(['image', 'source']);
    const models = registerKnowledgeModels(connection);
    const refs = await models.KnowledgeObjectRef.find({ workspaceId }).lean();
    expect(refs).toHaveLength(2);
    expect(refs.every((ref) => ref.state === 'active')).toBe(true);
    expect(refs.map((ref) => ref.purpose).sort()).toEqual(['image', 'source']);
    const storedSource = await models.KnowledgeSource.findById(source.id).lean();
    expect(storedSource?.contentHash).toBe(digest(parse.rawText));
    expect(storedSource?.sourceVersion).toBe(1);
    expect(storedSource?.version).toBe(source.version);

    const second = await repository.materialize(
      {
        sourceId: source.id,
        sourceVersion: 1,
        knowledgeSpaceId: space.id,
        parse,
      },
      context,
    );
    expect(second.rawTextObjectRef.blobId).toBe(first.rawTextObjectRef.blobId);
    expect(await models.KnowledgeObjectRef.countDocuments({ workspaceId })).toBe(2);
    expect(store.puts).toHaveLength(2);
  });

  it('leaves a failed upload deleting and never exposes an active object', async () => {
    const { space, source } = await sourceFixture(`Artifact failure ${suffix}`);
    const repository = new S5ArtifactRepository(connection, new FailingStore());
    const parse = parseResult('OFD page that fails upload');
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
    ).rejects.toThrow('object store unavailable');
    const refs = await registerKnowledgeModels(connection)
      .KnowledgeObjectRef.find({
        workspaceId,
        sha256: digest(parse.rawText),
      })
      .lean();
    expect(refs).toHaveLength(1);
    expect(refs[0]?.state).toBe('deleting');
    const storedSource = await registerKnowledgeModels(connection)
      .KnowledgeSource.findById(source.id)
      .lean();
    expect(storedSource?.contentHash).not.toBe(digest(parse.rawText));
  });

  it('keeps the C2 processing contract fields explicit', () => {
    type C2Keys = keyof S5ProcessingResult;
    const keys: C2Keys[] = [
      'sourceVersion',
      'rawText',
      'rawTextObjectRef',
      'pages',
      'assets',
      'diagnostics',
      'chunks',
      'qaItems',
      'evidence',
    ];
    expect(keys).toHaveLength(9);
  });
});
