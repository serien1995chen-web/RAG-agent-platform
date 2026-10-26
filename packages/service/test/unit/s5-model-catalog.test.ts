import { describe, expect, it } from 'vitest';
import { S5AiproxyCatalogAdapter } from '../../src/modules/knowledge/adapter/s5-aiproxy-catalog.adapter';
import type {
  S5HttpRequest,
  S5HttpResponse,
  S5HttpTransportPort,
} from '../../src/modules/knowledge/adapter/s5-aiproxy-http.adapter';
import { S5ModelApplication } from '../../src/modules/knowledge/application/s5-model.application';
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
