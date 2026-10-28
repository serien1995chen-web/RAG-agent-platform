import { describe, expect, it } from 'vitest';
import { S5AiproxyHttpAdapter } from '../../src/modules/knowledge/adapter/s5-aiproxy-http.adapter';

describe('TEST-MODEL-002-BLOCK ordered embedding input', () => {
  it('preserves text/image_url order without a provider SDK', async () => {
    let body: unknown;
    const adapter = new S5AiproxyHttpAdapter({
      baseUrl: 'https://aiproxy.example.invalid',
      token: 'token',
      transport: {
        async request(input) {
          body = input.body;
          return {
            status: 200,
            headers: {},
            data: {
              data: [
                { index: 0, embedding: Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)) },
                { index: 1, embedding: Array.from({ length: 768 }, (_, i) => (i === 1 ? 1 : 0)) },
              ],
              usage: { prompt_tokens: 3, total_tokens: 3 },
            },
          };
        },
      },
    });
    await adapter.invoke(
      {
        kind: 'embedding',
        modelId: 'vision-embedding',
        input: [
          { type: 'text', text: 'refund flow' },
          {
            type: 'image_url',
            image_url: { url: 'https://files.example.invalid/content?ticket=safe' },
          },
        ],
        dimension: 768,
      },
      { workspaceId: 'ws-embedding', requestId: 'req-embedding', traceId: 'trace-embedding' },
    );
    expect(body).toMatchObject({
      model: 'vision-embedding',
      input: [
        { type: 'text', text: 'refund flow' },
        {
          type: 'image_url',
          image_url: { url: 'https://files.example.invalid/content?ticket=safe' },
        },
      ],
    });
  });
});
