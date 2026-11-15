import { describe, expect, it } from 'vitest';
import { KnowledgeUrlImportAdapter } from '../../packages/service/src/modules/knowledge/adapter/url-import';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws_b10_fault',
  memberId: 'mem_b10_fault',
  requestId: 'req_b10_fault',
  traceId: 'trace_b10_fault',
  scopes: ['knowledge:write'],
};

function adapterWithStatus(status: number) {
  return new KnowledgeUrlImportAdapter({
    async resolve(raw) {
      return {
        url: new URL(raw),
        address: '93.184.216.34',
        family: 4,
        addresses: ['93.184.216.34'],
      };
    },
    async requestPage() {
      return {
        status,
        location: null,
        contentType: 'text/html',
        bytes: Buffer.from('remote error body must not leak'),
      };
    },
  });
}

describe('L1-B10-ING-003-N02/F01 URL import fault classification', () => {
  it('L1-B10-ING-003-N02 maps remote 401/403/404/429/5xx without leaking the body', async () => {
    for (const status of [401, 403, 404, 429, 500, 502, 503]) {
      const error = await adapterWithStatus(status)
        .fetch({
          url: 'https://public.example.test/failure',
          selector: 'body',
          context,
        })
        .catch((caught: unknown) => caught);
      expect(error, String(status)).toMatchObject({
        problem: {
          error: {
            code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
            details: { providerStatus: status },
          },
        },
      });
      expect(JSON.stringify(error)).not.toContain('remote error body must not leak');
    }
  });

  it('L1-B10-ING-003-F01 maps DNS failures to retryable unavailable without a request', async () => {
    let requests = 0;
    const adapter = new KnowledgeUrlImportAdapter({
      async resolve() {
        throw Object.assign(new Error('dns-failed'), {
          problem: {
            error: {
              code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
              details: { dependency: 'dns' },
            },
          },
        });
      },
      async requestPage() {
        requests += 1;
        throw new Error('network must not be reached');
      },
    });

    await expect(
      adapter.fetch({ url: 'https://missing.example.test', selector: 'body', context }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE' } },
    });
    expect(requests).toBe(0);
  });

  it('L1-B10-ING-003-Q06 preserves timeout and streamed size classifications', async () => {
    for (const [code, message] of [
      ['KNOWLEDGE_DEPENDENCY_TIMEOUT', 'timeout'],
      ['KNOWLEDGE_PAYLOAD_TOO_LARGE', 'too-large'],
    ] as const) {
      const adapter = new KnowledgeUrlImportAdapter({
        async resolve(raw) {
          return {
            url: new URL(raw),
            address: '93.184.216.34',
            family: 4,
            addresses: ['93.184.216.34'],
          };
        },
        async requestPage() {
          throw Object.assign(new Error(message), {
            problem: { error: { code } },
          });
        },
      });
      await expect(
        adapter.fetch({ url: 'https://public.example.test/file', selector: 'body', context }),
      ).rejects.toMatchObject({ problem: { error: { code } } });
    }
  });
});
