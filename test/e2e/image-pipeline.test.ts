import { describe, expect, it } from 'vitest';
import { createChainJobDispatch } from '../../packages/service/src/modules/processing/jobs/registry';
import { createImageJobHandler } from '../../packages/service/src/modules/processing/jobs/image.handler';
import { JOB_MODE_TO_QUEUE, QUEUE_NAMES } from '../../packages/dal/src/index';
import type { ImageTrainingProcessorPort } from '../../packages/service/src/ports/capabilities';
import type { JobEnvelope, RequestContext } from '../../packages/service/src/ports/types';

const context: RequestContext = {
  requestId: 'req-e2e-image',
  tenant: { teamId: 'team-1', tmbId: 'tmb-1', authType: 'internal', isRoot: false },
  permission: { canRead: true, canWrite: true, canManage: false, isOwner: false },
};

function envelope(mode: 'image' | 'imageParse'): JobEnvelope {
  return {
    jobId: 'team-1:ds-1:img-1:' + mode,
    queue: JOB_MODE_TO_QUEUE[mode] ?? QUEUE_NAMES[mode],
    mode,
    teamId: 'team-1',
    datasetId: 'ds-1',
    dataId: 'data-1',
    retryCount: 0,
    lockTime: null,
    payload: { imageRef: { bucket: 'kb-images', key: 'img-1.png' } },
  };
}

describe('TEST-E2E-IMAGE-001 image pipeline dispatch', () => {
  it('registers image and imageParse handlers and dispatches both', async () => {
    const seen: string[] = [];
    const processor: ImageTrainingProcessorPort = {
      processImage: async (task) => {
        seen.push(task.mode);
        return { imageId: task.payload.imageRef.key, state: 'success', description: 'e2e' };
      },
    };
    const handler = createImageJobHandler({ processor });
    const dispatch = createChainJobDispatch([
      {
        definition: {
          name: 'processing-image',
          queue: QUEUE_NAMES.image,
          modes: ['image'],
          stableIdTemplate: 'teamId:datasetId:imageId:image',
        },
        handler,
      },
      {
        definition: {
          name: 'processing-image-parse',
          queue: QUEUE_NAMES.imageParse,
          modes: ['imageParse'],
          stableIdTemplate: 'teamId:datasetId:imageId:imageParse',
        },
        handler,
      },
    ]);
    const a = await dispatch
      .resolve(QUEUE_NAMES.image, 'image', { requestId: 'r', taskId: 't' })
      .handle(envelope('image'), context);
    const b = await dispatch
      .resolve(QUEUE_NAMES.imageParse, 'imageParse', { requestId: 'r', taskId: 't' })
      .handle(envelope('imageParse'), context);
    expect(a.state).toBe('success');
    expect(b.state).toBe('success');
    expect(seen).toEqual(['image', 'imageParse']);
  });

  it('surfaces a single-image failure without hiding it', async () => {
    const processor: ImageTrainingProcessorPort = {
      processImage: async () => ({
        imageId: 'img-1',
        state: 'failed',
        errorMsg: 'capability_missing',
      }),
    };
    const handler = createImageJobHandler({ processor });
    const result = await handler.handle(envelope('image'), context);
    expect(result.state).toBe('failed');
    expect(result.errorMsg).toBe('capability_missing');
  });
});
