import { ApiErrorException } from '@kb/contracts';
import { JOB_MODE_TO_QUEUE, QUEUE_NAMES } from '@kb/dal';
import { describe, expect, it } from 'vitest';
import {
  ConfigValidationException,
  KNOWLEDGE_ITEM_INDEX_JOB_DEFINITIONS,
  KNOWLEDGE_ITEM_JOB_DEFINITIONS,
  PROCESSING_JOB_JOB_DEFINITIONS,
  SOURCE_COLLECTION_JOB_DEFINITIONS,
  createKnowledgeItemJobHandler,
  createProcessingJobJobHandler,
  createSourceCollectionJobHandler,
} from '../../src/index';
import {
  createChainJobDispatch,
  type ChainJobHandler,
} from '../../src/modules/processing/jobs/registry';
import type { TaskEnvelope, TrainingProcessorPort } from '../../src/ports/capabilities';
import type { JobDefinition, JobEnvelope, RequestContext } from '../../src/ports/types';

const context: RequestContext = {
  requestId: 'req-1',
  tenant: { teamId: 'team-1', tmbId: 'tmb-1', authType: 'internal', isRoot: false },
  permission: { canRead: true, canWrite: true, canManage: false, isOwner: false },
};

function envelopeOf(overrides: Partial<JobEnvelope>): JobEnvelope {
  return {
    jobId: 'job-1',
    queue: QUEUE_NAMES.parse,
    mode: 'parse',
    teamId: 'team-1',
    retryCount: 3,
    lockTime: null,
    payload: {},
    ...overrides,
  };
}

const passthroughHandler: ChainJobHandler = {
  handle: async () => ({ state: 'success' }),
};

describe('处理链 Job Handler 注册 (P3-03 / 设计 12.10)', () => {
  it('parse/chunk/qa/vector 按 JOB_MODE_TO_QUEUE 注册，collection/item 定义与处理链一致', () => {
    for (const mode of ['parse', 'chunk', 'qa', 'vector']) {
      const definition = PROCESSING_JOB_JOB_DEFINITIONS.find((item) => item.modes.includes(mode));
      expect(definition, `缺少 mode=${mode} 的处理链定义`).toBeDefined();
      expect(definition?.queue).toBe(JOB_MODE_TO_QUEUE[mode]);
      expect(definition?.modes).toEqual([mode]);
    }

    const chainByMode = new Map(
      PROCESSING_JOB_JOB_DEFINITIONS.map((definition) => [definition.modes[0], definition]),
    );
    for (const definition of [
      ...SOURCE_COLLECTION_JOB_DEFINITIONS,
      ...KNOWLEDGE_ITEM_JOB_DEFINITIONS,
    ]) {
      const chain = chainByMode.get(definition.modes[0]);
      expect(chain, `缺少 ${definition.name} 对应的处理链定义`).toBeDefined();
      expect(definition.queue).toBe(chain?.queue);
      expect(definition.stableIdTemplate).toBe(chain?.stableIdTemplate);
    }
  });

  it('所有导出定义不出现契约外队列（dataset-training / dataset-index）', () => {
    const all = [
      ...PROCESSING_JOB_JOB_DEFINITIONS,
      ...SOURCE_COLLECTION_JOB_DEFINITIONS,
      ...KNOWLEDGE_ITEM_JOB_DEFINITIONS,
      ...KNOWLEDGE_ITEM_INDEX_JOB_DEFINITIONS,
    ];
    const queueNames = new Set<string>(Object.values(QUEUE_NAMES));
    for (const definition of all) {
      expect(queueNames.has(definition.queue), `${definition.name} 使用契约外队列`).toBe(true);
      for (const mode of definition.modes) {
        expect(JOB_MODE_TO_QUEUE[mode]).toBe(definition.queue);
      }
    }
    expect(KNOWLEDGE_ITEM_INDEX_JOB_DEFINITIONS).toEqual([]);
    expect(
      all.some(
        (definition) =>
          definition.queue === 'dataset-training' || definition.queue === 'dataset-index',
      ),
    ).toBe(false);
  });

  it('重复注册 (queue, mode) 启动失败；未注册组合返回 501005', async () => {
    const definition: JobDefinition = {
      name: 'dup-parse',
      queue: QUEUE_NAMES.parse,
      modes: ['parse'],
      stableIdTemplate: 'teamId:datasetId:collectionId:parse:version',
    };
    expect(() =>
      createChainJobDispatch([
        { definition, handler: passthroughHandler },
        { definition, handler: passthroughHandler },
      ]),
    ).toThrow(ConfigValidationException);

    const dispatch = createChainJobDispatch([{ definition, handler: passthroughHandler }]);
    let caught: unknown;
    try {
      dispatch.resolve(QUEUE_NAMES.qa, 'qa', { requestId: 'req-1', taskId: 'task-1' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiErrorException);
    expect((caught as ApiErrorException).error.code).toBe(501005);

    const handler = createProcessingJobJobHandler({
      handlersByMode: {
        parse: passthroughHandler,
        chunk: passthroughHandler,
        qa: passthroughHandler,
        vector: passthroughHandler,
      },
    });
    await expect(
      handler.handle(envelopeOf({ queue: QUEUE_NAMES.image, mode: 'image' }), context),
    ).rejects.toBeInstanceOf(ApiErrorException);
  });

  it('payload 白名单映射：正文/密钥/未知字段不进入 Port 调用', async () => {
    let received: TaskEnvelope | undefined;
    const trainingProcessor: TrainingProcessorPort = {
      process: async (task) => {
        received = task;
        return { state: 'success', producedItems: 1 };
      },
    };

    const collectionHandler = createSourceCollectionJobHandler({ trainingProcessor });
    const result = await collectionHandler.handle(
      envelopeOf({
        queue: QUEUE_NAMES.parse,
        mode: 'parse',
        datasetId: 'ds-1',
        collectionId: 'col-1',
        payload: {
          taskId: 'task-9',
          version: 7,
          sourceRef: 'source://ref',
          policy: { mode: 'auto' },
          datasetId: 'ds-1',
          collectionId: 'col-1',
          text: 'RAW SECRET BODY',
          rawText: 'RAW',
          token: 'tok',
          apiKey: 'key',
          unknownField: 'drop-me',
        },
      }),
      context,
    );
    expect(result.state).toBe('success');
    expect(received?.taskId).toBe('task-9');
    expect(received?.mode).toBe('parse');
    expect(received?.payload).toEqual({
      taskId: 'task-9',
      version: 7,
      sourceRef: 'source://ref',
      policy: { mode: 'auto' },
      datasetId: 'ds-1',
      collectionId: 'col-1',
    });
    expect(JSON.stringify(received?.payload)).not.toContain('SECRET');
    expect(JSON.stringify(received?.payload)).not.toContain('key');

    const itemHandler = createKnowledgeItemJobHandler({ trainingProcessor });
    await itemHandler.handle(
      envelopeOf({
        queue: QUEUE_NAMES.qa,
        mode: 'qa',
        dataId: 'data-1',
        payload: { taskId: 'task-10', chunk: { text: '正文' }, secret: 's' },
      }),
      context,
    );
    expect(received?.payload).toEqual({ taskId: 'task-10' });
    expect(received?.dataId).toBe('data-1');
  });
});
