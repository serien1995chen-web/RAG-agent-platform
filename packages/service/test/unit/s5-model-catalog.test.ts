import { describe, expect, it } from 'vitest';
import { S5AiproxyCatalogAdapter } from '../../src/modules/knowledge/adapter/s5-aiproxy-catalog.adapter';
import type {
  S5HttpRequest,
  S5HttpResponse,
  S5HttpTransportPort,
} from '../../src/modules/knowledge/adapter/s5-aiproxy-http.adapter';
import { S5ModelApplication } from '../../src/modules/knowledge/application/s5-model.application';
import { S5ModelBindingApplication } from '../../src/modules/knowledge/application/s5-model-binding.application';
import type {
  ModelCatalogItem,
  ModelCatalogPort,
  ModelBindingView,
} from '../../src/modules/knowledge/application/s5-model-ports';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';
import type { S5AiproxyConfig } from '../../src/shared/config/s5-aiproxy-config';

const context: TenantContext = {
  workspaceId: 'ws_model_catalog',
  memberId: 'mem_model_catalog',
  requestId: 'req-model-catalog',
  traceId: 'trace-model-catalog',
  scopes: ['knowledge:read', 'knowledge:write'],
};

const config: S5AiproxyConfig = {
  mode: 'external',
  baseUrl: 'https://aiproxy.example.invalid/v1',
  apiTokenRef: 'env:AIPROXY_API_TOKEN',
  postgresUriRef: null,
  modelMode: 'real',
};

function input(operationId: string, body: unknown = {}, query: Record<string, string> = {}) {
  return {
    operationId,
    params: {},
    query,
    body,
    context,
  };
}

function catalogResponse(data: unknown, status = 200): S5HttpResponse {
  return { status, headers: {}, data };
}

function catalogOf(models: ModelCatalogItem[]): ModelCatalogPort {
  return {
    async listModels() {
      return models;
    },
  };
}

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function model(index: number, type: ModelCatalogItem['type'] = 'llm'): ModelCatalogItem {
  return {
    modelId: `model-${String(index).padStart(3, '0')}`,
    displayName: `Model ${index}`,
    type,
    capabilities: ['chat'],
    dimension: null,
    authorized: true,
  };
}

describe('TEST-MODEL-001-BLOCK AIProxy catalog and model operations', () => {
  it('sends Bearer and workspace headers and normalizes a sorted catalog', async () => {
    let captured: S5HttpRequest | undefined;
    const transport: S5HttpTransportPort = {
      async request<T>(request: S5HttpRequest) {
        captured = request;
        return catalogResponse({
          data: [
            {
              id: 'embedding-1024',
              display_name: 'Embedding 1024',
              type: 'embedding',
              capabilities: ['text-embedding'],
              dimension: 1024,
            },
            { id: 'llm-general', type: 'llm', capabilities: ['chat'] },
            { id: 'stt-general', type: 'stt', capabilities: ['speech-to-text'] },
          ],
        }) as S5HttpResponse<T>;
      },
    };
    const catalog = new S5AiproxyCatalogAdapter({
      config,
      transport,
      env: { AIPROXY_API_TOKEN: 'fake-catalog-token' },
    });
    const application = new S5ModelApplication(catalog);
    const result = await application.dispatch(input('API-MODEL-LIST'));
    expect(result.status).toBe(200);
    const items = (result.data as { items: Array<Record<string, unknown>> }).items;
    expect(items.map((item) => item.type)).toEqual(['llm', 'embedding', 'stt']);
    expect(items[1]?.capabilities).toEqual(['dimension:1024', 'text-embedding']);
    expect(captured?.headers.Authorization).toBe('Bearer fake-catalog-token');
    expect(captured?.headers['X-Workspace-Id']).toBe(context.workspaceId);
    expect(captured?.url).toBe('https://aiproxy.example.invalid/v1/models');
  });

  it('keeps an empty authorized catalog empty and never guesses models', async () => {
    const transport: S5HttpTransportPort = {
      async request<T>() {
        return catalogResponse({ data: [] }) as S5HttpResponse<T>;
      },
    };
    const application = new S5ModelApplication(
      new S5AiproxyCatalogAdapter({
        config,
        transport,
        env: { AIPROXY_API_TOKEN: 'fake-catalog-token' },
      }),
    );
    await expect(application.dispatch(input('API-MODEL-LIST'))).resolves.toMatchObject({
      status: 200,
      data: { items: [] },
    });
  });

  it('defaults MODEL-LIST to 50 items and applies cursor pagination', async () => {
    const models = Array.from({ length: 60 }, (_, index) => ({
      id: `llm-${String(index).padStart(3, '0')}`,
      type: 'llm',
      capabilities: ['chat'],
    }));
    const application = new S5ModelApplication(
      new S5AiproxyCatalogAdapter({
        config,
        transport: {
          async request<T>() {
            return catalogResponse({ data: models }) as S5HttpResponse<T>;
          },
        },
        env: { AIPROXY_API_TOKEN: 'fake-catalog-token' },
      }),
    );
    const first = await application.dispatch(input('API-MODEL-LIST'));
    const firstData = first.data as {
      items: unknown[];
      pageInfo: { hasMore: boolean; nextCursor: string | null };
    };
    expect(firstData.items).toHaveLength(50);
    expect(firstData.pageInfo).toMatchObject({ hasMore: true });
    const second = await application.dispatch(
      input('API-MODEL-LIST', {}, { cursor: firstData.pageInfo.nextCursor ?? '' }),
    );
    const secondData = second.data as {
      items: Array<{ modelId: string }>;
      pageInfo: { hasMore: boolean; nextCursor: string | null };
    };
    expect(secondData.items).toHaveLength(10);
    expect(secondData.items[0]?.modelId).toBe('llm-050');
    expect(secondData.pageInfo).toEqual({ hasMore: false, nextCursor: null });
    const traversed = [...(firstData.items as Array<{ modelId: string }>), ...secondData.items].map(
      (item) => item.modelId,
    );
    expect(new Set(traversed).size).toBe(60);
    expect(traversed).toEqual(models.map((item) => item.id));
    await expect(
      application.dispatch(input('API-MODEL-LIST', {}, { cursor: 'not-a-cursor' })),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
  });

  it('does not repeat returned keys when a new item is inserted before the cursor', async () => {
    let current = [model(1), model(2), model(3)];
    const application = new S5ModelApplication({
      async listModels() {
        return current;
      },
    });
    const first = await application.dispatch(input('API-MODEL-LIST', {}, { limit: '2' }));
    const firstData = first.data as {
      items: Array<{ modelId: string }>;
      pageInfo: { nextCursor: string | null };
    };
    expect(firstData.items.map((item) => item.modelId)).toEqual(['model-001', 'model-002']);

    current = [model(0), ...current];
    const second = await application.dispatch(
      input(
        'API-MODEL-LIST',
        {},
        {
          limit: '2',
          cursor: firstData.pageInfo.nextCursor ?? '',
        },
      ),
    );
    expect(
      (second.data as { items: Array<{ modelId: string }> }).items.map((item) => item.modelId),
    ).toEqual(['model-003']);
  });

  it('binds cursor to sort and rejects offset, invalid versions, fields and base64', async () => {
    const application = new S5ModelApplication(catalogOf([model(1), model(2), model(3)]));
    const first = await application.dispatch(
      input('API-MODEL-LIST', {}, { limit: '1', sort: 'modelType' }),
    );
    const cursor = (first.data as { pageInfo: { nextCursor: string | null } }).pageInfo.nextCursor;
    expect(cursor).not.toBeNull();
    await expect(
      application.dispatch(input('API-MODEL-LIST', {}, { cursor: cursor ?? '', sort: 'modelId' })),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });

    const valid = { v: 1, sort: 'modelType', lastModelType: 'llm', lastModelId: 'model-001' };
    for (const invalidCursor of [
      'not-a-cursor',
      'not%base64',
      `${encodeCursor(valid)}!`,
      encodeCursor({ ...valid, v: 2 }),
      encodeCursor({ ...valid, offset: 1 }),
      encodeCursor({ ...valid, lastModelType: 'unknown' }),
      encodeCursor({ v: 1, sort: 'modelType', lastModelType: 'llm' }),
      encodeCursor({ offset: 1 }),
    ]) {
      await expect(
        application.dispatch(input('API-MODEL-LIST', {}, { cursor: invalidCursor })),
      ).rejects.toMatchObject({
        problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
      });
    }
    await expect(
      application.dispatch(
        input(
          'API-MODEL-LIST',
          {},
          {
            cursor: encodeCursor({
              ...valid,
              lastModelId: 'model-that-does-not-exist',
            }),
          },
        ),
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
  });

  it('supports only the four model key sorts and ignores an unregistered type filter', async () => {
    const models = [
      { ...model(2, 'llm'), modelId: 'b' },
      { ...model(1, 'embedding'), modelId: 'c' },
      { ...model(3, 'llm'), modelId: 'a' },
    ];
    const application = new S5ModelApplication(catalogOf(models));
    const idsFor = async (sort: string) =>
      (
        (await application.dispatch(input('API-MODEL-LIST', {}, { sort }))).data as {
          items: Array<{ modelId: string }>;
        }
      ).items.map((item) => item.modelId);
    expect(await idsFor('modelType')).toEqual(['a', 'b', 'c']);
    expect(await idsFor('-modelType')).toEqual(['c', 'b', 'a']);
    expect(await idsFor('modelId')).toEqual(['a', 'b', 'c']);
    expect(await idsFor('-modelId')).toEqual(['c', 'b', 'a']);
    expect(
      (
        (await application.dispatch(input('API-MODEL-LIST', {}, { type: 'embedding' }))).data as {
          items: Array<{ modelId: string }>;
        }
      ).items.map((item) => item.modelId),
    ).toEqual(['a', 'b', 'c']);
    for (const sort of ['updatedAt', '-updatedAt', 'createdAt', 'type']) {
      await expect(
        application.dispatch(input('API-MODEL-LIST', {}, { sort })),
      ).rejects.toMatchObject({
        problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
      });
    }
  });

  it('paginates every supported key sort without duplicates or omissions', async () => {
    const models: ModelCatalogItem[] = [
      { ...model(1), modelId: 'llm-b', type: 'llm' },
      { ...model(2), modelId: 'embedding-a', type: 'embedding' },
      { ...model(3), modelId: 'llm-a', type: 'llm' },
      { ...model(4), modelId: 'tts-a', type: 'tts' },
      { ...model(5), modelId: 'embedding-b', type: 'embedding' },
    ];
    const application = new S5ModelApplication(catalogOf(models));
    const ids = async (query: Record<string, string>) =>
      (await application.dispatch(input('API-MODEL-LIST', {}, query))).data as {
        items: Array<{ modelId: string }>;
        pageInfo: { hasMore: boolean; nextCursor: string | null };
      };

    for (const sort of ['modelType', '-modelType', 'modelId', '-modelId']) {
      const expected = (await ids({ sort, limit: '200' })).items.map((item) => item.modelId);
      const traversed: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await ids({
          sort,
          limit: '2',
          ...(cursor ? { cursor } : {}),
        });
        traversed.push(...page.items.map((item) => item.modelId));
        cursor = page.pageInfo.nextCursor;
      } while (cursor);
      expect(traversed).toEqual(expected);
      expect(new Set(traversed).size).toBe(models.length);
    }
  });

  it('validates type, required capabilities and all four embedding dimensions', async () => {
    const models = [768, 1024, 1536, 3072].map((dimension) => ({
      id: `embedding-${dimension}`,
      type: 'embedding',
      capabilities: ['text-embedding'],
      dimension,
    }));
    const transport: S5HttpTransportPort = {
      async request<T>() {
        return catalogResponse({ data: models }) as S5HttpResponse<T>;
      },
    };
    const application = new S5ModelApplication(
      new S5AiproxyCatalogAdapter({
        config,
        transport,
        env: { AIPROXY_API_TOKEN: 'fake-catalog-token' },
      }),
    );
    for (const dimension of [768, 1024, 1536, 3072]) {
      await expect(
        application.dispatch(
          input('API-MODEL-BINDING-VALIDATE', {
            modelId: `embedding-${dimension}`,
            modelType: 'embedding',
            requiredCapabilities: ['text-embedding', `dimension:${dimension}`],
          }),
        ),
      ).resolves.toMatchObject({ status: 200, data: { valid: true } });
    }
    await expect(
      application.dispatch(
        input('API-MODEL-BINDING-VALIDATE', {
          modelId: 'embedding-768',
          modelType: 'embedding',
          requiredCapabilities: ['dimension:1024'],
        }),
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
    await expect(
      application.dispatch(
        input('API-MODEL-BINDING-VALIDATE', {
          modelId: 'embedding-768',
          modelType: 'llm',
          requiredCapabilities: [],
        }),
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
  });

  it('classifies auth and invalid schema without returning an empty catalog', async () => {
    for (const response of [
      catalogResponse({ error: 'unauthorized' }, 401),
      catalogResponse({ data: [{ id: 'missing-fields' }] }, 200),
      catalogResponse({ data: [{ id: 'llm-no-capabilities', type: 'llm' }] }, 200),
    ]) {
      const transport: S5HttpTransportPort = {
        async request<T>() {
          return response as S5HttpResponse<T>;
        },
      };
      const catalog = new S5AiproxyCatalogAdapter({
        config,
        transport,
        env: { AIPROXY_API_TOKEN: 'fake-catalog-token' },
      });
      await expect(
        catalog.listModels({
          workspaceId: context.workspaceId,
          requestId: context.requestId,
          traceId: context.traceId,
        }),
      ).rejects.toMatchObject({
        problem: {
          error: {
            code:
              response.status === 401
                ? 'KNOWLEDGE_MODEL_FAILED'
                : 'KNOWLEDGE_PROVIDER_CONTRACT_INVALID',
          },
        },
      });
    }
  });

  it('rejects BINDING-GET limit, cursor and sort values instead of returning 200', async () => {
    const application = new S5ModelBindingApplication(
      {
        async list() {
          return [];
        },
        async replace() {
          return { items: [], version: 1 };
        },
      },
      {
        async listModels() {
          return [];
        },
      },
      {
        async assertPermission() {},
      },
    );
    const bindingInput = (query: Record<string, string>) => ({
      ...input('API-MODEL-BINDING-GET'),
      params: { spaceId: 'space-1' },
      query,
    });
    for (const query of [{ limit: '0' }, { cursor: 'bad' }, { sort: 'updatedAt-desc-nope' }]) {
      await expect(application.dispatch(bindingInput(query))).rejects.toMatchObject({
        problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
      });
    }
    await expect(
      application.dispatch(
        bindingInput({
          cursor: encodeCursor({
            v: 1,
            sort: 'modelType',
            lastModelType: 'llm',
            lastModelId: 'missing-binding',
          }),
        }),
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
  });

  it('paginates all six model bindings with the shared PageInfo contract', async () => {
    const bindings: ModelBindingView[] = ['llm', 'embedding', 'rerank', 'vlm', 'stt', 'tts'].map(
      (modelType, index) => ({
        modelType: modelType as ModelBindingView['modelType'],
        modelId: `binding-${index}`,
        displayName: `Binding ${index}`,
        requiredCapabilities: ['capability'],
        status: 'active',
      }),
    );
    const application = new S5ModelBindingApplication(
      {
        async list() {
          return bindings;
        },
        async replace() {
          return { items: [], version: 1 };
        },
      },
      catalogOf([]),
      {
        async assertPermission() {},
      },
    );
    const bindingInput = (query: Record<string, string>) => ({
      ...input('API-MODEL-BINDING-GET'),
      params: { spaceId: 'space-1' },
      query,
    });
    const defaultPage = await application.dispatch(bindingInput({}));
    expect(defaultPage.data).toMatchObject({
      items: bindings,
      pageInfo: { hasMore: false, nextCursor: null },
    });
    const traversed: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const result = await application.dispatch(
        bindingInput({ limit: '2', ...(cursor ? { cursor } : {}) }),
      );
      const data = result.data as {
        items: ModelBindingView[];
        pageInfo: { hasMore: boolean; nextCursor: string | null };
      };
      traversed.push(...data.items.map((item) => item.modelId));
      cursor = data.pageInfo.nextCursor;
      pages += 1;
      expect(data.pageInfo.hasMore).toBe(cursor !== null);
    } while (cursor);
    expect(pages).toBe(3);
    expect(traversed).toEqual(bindings.map((binding) => binding.modelId));
    expect(new Set(traversed).size).toBe(6);
  });

  it('does not expand catalog authorization through query filters', async () => {
    const orderedIds: string[] = [];
    const transport: S5HttpTransportPort = {
      async request<T>() {
        orderedIds.push('request');
        return catalogResponse({
          data: [
            { id: 'llm-b', type: 'llm', capabilities: ['chat'] },
            { id: 'llm-a', type: 'llm', capabilities: ['chat'] },
          ],
        }) as S5HttpResponse<T>;
      },
    };
    const application = new S5ModelApplication(
      new S5AiproxyCatalogAdapter({
        config,
        transport,
        env: { AIPROXY_API_TOKEN: 'fake-catalog-token' },
      }),
    );
    const result = await application.dispatch(input('API-MODEL-LIST', {}, { limit: '1' }));
    expect((result.data as { items: Array<{ modelId: string }> }).items).toEqual([
      expect.objectContaining({ modelId: 'llm-a' }),
    ]);
    expect(orderedIds).toHaveLength(1);
  });
});
