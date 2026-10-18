import { describe, expect, it } from 'vitest';
import {
  createMockImageCapability,
  detectImageMimeType,
} from '../../src/modules/collection/adapter/image-capability.mock';
import { createImageProcessorAdapter } from '../../src/modules/collection/adapter/image-processor.adapter';
import type { RequestContext } from '../../src/ports/types';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP478+AFWEXHbQSAOBoU4FwyX8rAAAAAElFTkSuQmCC',
  'base64',
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF = Buffer.from('GIF89a', 'ascii');
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x20, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'ascii'),
]);

const context: RequestContext = {
  requestId: 'req-image-capability',
  tenant: { teamId: 'team-1', tmbId: 'tmb-1', authType: 'internal', isRoot: false },
  permission: { canRead: true, canWrite: true, canManage: false, isOwner: false },
};

describe('mock image capability', () => {
  it('detects PNG/JPEG/GIF/WebP magic bytes and rejects text', () => {
    expect(detectImageMimeType(PNG)).toBe('image/png');
    expect(detectImageMimeType(JPEG)).toBe('image/jpeg');
    expect(detectImageMimeType(GIF)).toBe('image/gif');
    expect(detectImageMimeType(WEBP)).toBe('image/webp');
    expect(detectImageMimeType(Buffer.from('not an image'))).toBeNull();
  });

  it('reads the object and returns deterministic embedding, description only for imageParse', async () => {
    const capability = createMockImageCapability({
      objectStore: {
        get: async () => ({ ref: { bucket: 'kb', key: 'k' }, body: PNG }),
      } as never,
    });
    const imageRef = { bucket: 'kb', key: 'k' };
    const chunk = await capability.describeImage(
      { imageRef, datasetId: 'dataset-1', mode: 'chunk', options: { timeoutMs: 1000 } },
      context,
    );
    const parsed = await capability.describeImage(
      { imageRef, datasetId: 'dataset-1', mode: 'imageParse', options: { timeoutMs: 1000 } },
      context,
    );
    expect(chunk.description).toBe('');
    expect(parsed.description).toContain('image/png');
    expect(chunk.embedding).toHaveLength(1536);
    expect(parsed.embedding).toEqual(chunk.embedding);
  });

  it('fails closed when the processor is not configured and in production mock mode', async () => {
    const notConfigured = createImageProcessorAdapter({ configured: false });
    const task = {
      taskId: 'task-1',
      teamId: 'team-1',
      datasetId: 'dataset-1',
      collectionId: 'collection-1',
      dataId: 'data-1',
      mode: 'image',
      payload: { imageRef: { bucket: 'kb', key: 'k' } },
    };
    await expect(
      notConfigured.processImage(task, task.payload.imageRef, context),
    ).resolves.toMatchObject({ state: 'failed' });

    const capability = createMockImageCapability({
      objectStore: { get: async () => ({ body: PNG }) } as never,
    });
    const productionMock = createImageProcessorAdapter({
      capability,
      configured: true,
      mock: true,
      environment: 'production',
    });
    await expect(
      productionMock.processImage(task, task.payload.imageRef, context),
    ).rejects.toMatchObject({ error: { code: 501063 } });
  });
});
