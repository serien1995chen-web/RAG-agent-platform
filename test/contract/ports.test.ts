import { describe, expect, it } from 'vitest';
import {
  ApiErrorException,
  DEFAULT_PORT_IDS,
  createKnowledgeItemIndexAdapter,
  createDefaultPorts,
} from '../../packages/service/src/index';
import type { RequestContext } from '../../packages/service/src/index';

const context: RequestContext = {
  requestId: 'req-port-test',
  tenant: { teamId: 'team-a', tmbId: 'tmb-a', authType: 'token', isRoot: false },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: false },
};

interface ProbeablePort {
  __probe?: () => Promise<unknown>;
}

describe('Port 契约（设计文档 7.6 / ADR-010）', () => {
  it('登记 38 个 Port 且键名唯一', () => {
    expect(DEFAULT_PORT_IDS).toHaveLength(38);
    expect(new Set(DEFAULT_PORT_IDS).size).toBe(38);
  });

  it('默认空实现暴露全部 38 个 Port', () => {
    const ports = createDefaultPorts();
    expect(Object.keys(ports)).toHaveLength(38);
    for (const key of Object.keys(ports)) {
      expect(ports[key as keyof typeof ports], key).toBeDefined();
    }
  });

  it('任意 Port 调用都返回稳定错误 501999，而不是空值或伪造成功', async () => {
    const ports = createDefaultPorts();
    for (const key of Object.keys(ports)) {
      const port = ports[key as keyof typeof ports] as unknown as ProbeablePort;
      let caught: unknown;
      try {
        await port.__probe?.();
      } catch (error) {
        caught = error;
      }
      expect(caught, key).toBeDefined();
      const apiError = caught as ApiErrorException;
      expect(apiError.error.code, key).toBe(501999);
      expect(apiError.error.params.port, key).toBeTruthy();
    }
  });

  it('代表性 Port 方法在默认实现下仍拒绝调用', async () => {
    const ports = createDefaultPorts();
    await expect(
      ports.knowledgeBaseRepository.get({ datasetId: 'd', options: { timeoutMs: 1 } }, context),
    ).rejects.toMatchObject({ error: { code: 501999 } });
    await expect(
      ports.vectorController.embRecall(
        {
          teamId: 'team-a',
          datasetId: 'd',
          vector: [0],
          limit: 1,
          options: { timeoutMs: 1 },
        },
        context,
      ),
    ).rejects.toMatchObject({ error: { code: 501999 } });
    await expect(
      ports.datasetSearch.search(
        {
          requestId: 'req-port-test',
          teamId: 'team-a',
          datasetIds: ['d'],
          textQueries: ['hello'],
          imageQueries: [],
          models: { embeddingModel: 'bge-m3' },
          searchMode: 'embedding',
          limit: 10,
          maxTokens: 4000,
          similarity: 0,
        },
        context,
      ),
    ).rejects.toMatchObject({ error: { code: 501999 } });
    await expect(
      (
        ports.logger.log as unknown as (
          event: string,
          fields: Record<string, unknown>,
        ) => Promise<unknown>
      )('dataset.test.event', {}),
    ).rejects.toBeInstanceOf(ApiErrorException);
  });

  it('P2 真实装配工厂在注入连接后不再返回占位对象', () => {
    const connection = {
      models: {},
      model: () => ({}),
    };
    const adapters = createKnowledgeItemIndexAdapter({
      connection: connection as never,
    });
    expect(adapters.fullText).toBeDefined();
    expect(typeof adapters.fullText?.search).toBe('function');
  });
});
