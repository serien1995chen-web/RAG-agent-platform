import { CitationSchema } from '@kb/contracts';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CitationService,
  type ResolvedCitationInput,
} from '../../src/modules/index/application/citation.service';
import {
  DEFAULT_PREVIEW_TTL_SECONDS,
  PREVIEW_URL_MAX_TTL_SECONDS,
} from '../../src/modules/index/domain/citation';
import type { ObjectRef, RequestContext } from '../../src/ports/types';
import { registerMongoModels } from '../../src/shared/persistence/schemas';
import { createPreviewSigner, type PreviewSigner } from '../../../../sdk/storage/src/presign';

const teamId = new mongoose.Types.ObjectId().toHexString();
const context: RequestContext = {
  requestId: 'req-citation',
  tenant: { teamId, tmbId: 'tmb-a', authType: 'token', isRoot: false },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: false },
};

const baseItem: ResolvedCitationInput = {
  dataId: 'data-1',
  chunkIndex: 2,
  datasetId: 'dataset-1',
  collectionId: 'collection-1',
  collectionName: '来源集合',
  sourceName: '来源文件',
  sourceType: 'file',
  quoteText: '引用内容',
  updateTime: new Date('2026-10-13T00:00:00.000Z').toISOString(),
  scores: [{ type: 'embedding', value: 0.9, index: 0 }],
};

let mongo: MongoMemoryServer;
let connection: mongoose.Connection;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  connection = mongoose.createConnection(mongo.getUri('kb_citation_it'));
  await connection.asPromise();
  const models = registerMongoModels(connection);
  await models.DatasetData.init();
  await models.DatasetCollection.init();
  await models.ImageAsset.init();
});

afterAll(async () => {
  await connection.close();
  await mongo.stop();
});

function forbiddenKeyPresent(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(forbiddenKeyPresent);
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(
    ([key, child]) =>
      ['imageId', 'objectKey', 'providerResponse', 'providerRaw', 'storageKey'].includes(key) ||
      forbiddenKeyPresent(child),
  );
}

describe('P5-05 citation service', () => {
  it('builds a complete masked Citation', async () => {
    const service = new CitationService({
      resolveImageRef: async () => null,
    });
    const citations = await service.build({ items: [baseItem], context });

    expect(citations).toHaveLength(1);
    expect(CitationSchema.safeParse(citations[0]).success).toBe(true);
    expect(citations[0]).toMatchObject({
      dataId: 'data-1',
      chunkIndex: 2,
      datasetId: 'dataset-1',
      collectionId: 'collection-1',
      collectionName: '来源集合',
      sourceName: '来源文件',
      sourceType: 'file',
      quoteText: '引用内容',
    });
  });

  it('does not expose internal image or provider fields', async () => {
    const service = new CitationService({
      resolveImageRef: async () => null,
    });
    const citations = await service.build({
      items: [{ ...baseItem, imageIds: ['img-1'] }],
      context,
    });
    expect(forbiddenKeyPresent(citations)).toBe(false);
    expect(JSON.stringify(citations)).not.toContain('objectKey');
    expect(JSON.stringify(citations)).not.toContain('providerResponse');
  });

  it('signs image previews last and only for final image count', async () => {
    let signCalls = 0;
    const service = new CitationService({
      resolveImageRef: async (imageId) => ({
        ref: { bucket: 'kb', key: `image/${teamId}/${imageId}` },
        datasetId: 'dataset-1',
      }),
      presignPreview: async () => {
        signCalls += 1;
        return `https://preview.test/${signCalls}`;
      },
    });
    const citations = await service.build({
      items: [{ ...baseItem, imageIds: ['img-1', 'img-2'] }],
      context,
    });
    expect(signCalls).toBe(2);
    expect(citations[0]?.imagePreviewUrls).toEqual([
      'https://preview.test/1',
      'https://preview.test/2',
    ]);
  });

  it('enforces preview expiry and tenant key scope', async () => {
    const signer = createPreviewSigner({
      endPoint: 'localhost',
      port: 9000,
      useSSL: false,
      accessKey: 'test-key',
      secretKey: 'test-secret',
      region: 'us-east-1',
    });
    const ref: ObjectRef = { bucket: 'kb-test', key: `image/${teamId}/file.png` };

    expect(await signer(ref, { teamId }, 3600)).toContain('X-Amz-Expires=3600');
    expect(await signer(ref, { teamId }, 7200)).toContain('X-Amz-Expires=7200');
    await expect(signer(ref, { teamId }, 3599)).rejects.toMatchObject({
      error: { code: 501050 },
    });
    await expect(signer(ref, { teamId }, 7201)).rejects.toMatchObject({
      error: { code: 501050 },
    });
    await expect(
      signer(
        { bucket: 'kb-test', key: `temp/${new mongoose.Types.ObjectId().toHexString()}/x` },
        { teamId },
      ),
    ).rejects.toMatchObject({ error: { code: 501061 } });
    expect(DEFAULT_PREVIEW_TTL_SECONDS).toBe(3600);
    expect(PREVIEW_URL_MAX_TTL_SECONDS).toBe(7200);
  });

  it('keeps repeated builds stable apart from presigned URLs', async () => {
    let calls = 0;
    const signer: PreviewSigner = async () => {
      calls += 1;
      return `https://preview.test/${calls}`;
    };
    const service = new CitationService({
      resolveImageRef: async (imageId) => ({
        ref: { bucket: 'kb', key: `image/${teamId}/${imageId}` },
        datasetId: 'dataset-1',
      }),
      presignPreview: signer,
    });
    const first = await service.build({ items: [{ ...baseItem, imageIds: ['img-1'] }], context });
    const second = await service.build({ items: [{ ...baseItem, imageIds: ['img-1'] }], context });
    const normalize = (citations: typeof first) =>
      citations.map((citation) => ({ ...citation, imagePreviewUrls: ['<signed>'] }));
    expect(normalize(second)).toEqual(normalize(first));
  });
});
