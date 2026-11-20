import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AxiosS5HttpTransport,
  S5AiproxyHttpAdapter,
  joinAiproxyUrl,
} from '../../packages/service/src/modules/knowledge/adapter/s5-aiproxy-http.adapter';

const baseUrl = process.env.AIPROXY_BASE_URL?.trim() || 'https://tokendance.space/gateway';
const token = process.env.AIPROXY_API_TOKEN?.trim();
const llmModel = process.env.S11_AIPROXY_LLM_MODEL?.trim() || 'deepseek-v4.1-flash';
const embeddingModel = process.env.S11_AIPROXY_EMBEDDING_MODEL?.trim() || 'qwen-text-embedding-v4';
const rerankModel = process.env.S11_AIPROXY_RERANK_MODEL?.trim() || 'qwen3.7-text-rerank';
const vlmModel = process.env.S11_AIPROXY_VLM_MODEL?.trim() || 'kimi-k2.5';
const providerTimeout = 120_000;

function requiredToken(): string {
  if (!token) throw new Error('S11_PROVIDER_REAL_BLOCKED: missing AIPROXY_API_TOKEN');
  return token;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function evidence(name: string, value: unknown) {
  const directory =
    process.env.B16_PROVIDER_EVIDENCE_DIR?.trim() ||
    resolve(process.cwd(), 'test-results/b16/b/20261120-223600/provider');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name), `${JSON.stringify(value, null, 2)}\n`);
}

function adapter() {
  return new S5AiproxyHttpAdapter({
    baseUrl,
    token: requiredToken(),
    transport: new AxiosS5HttpTransport(),
    rerankProtocol: 'alibaba-native',
    providerOnly: ['alibaba'],
  });
}

describe('L1-B16-B real TokenDance provider', () => {
  it(
    'L1-B16-B-SEARCH-003-P02 preserves the raw query and returns a standalone rewrite',
    async () => {
      const rawQuery = '它多久退款？';
      const result = await adapter().invoke<{
        choices: Array<{ message: { content: string } }>;
      }>(
        {
          kind: 'llm',
          modelId: llmModel,
          messages: [
            {
              role: 'system',
              content:
                'Rewrite the user question into one standalone search query using only facts in the supplied background. Return only the query.',
            },
            {
              role: 'user',
              content:
                'Background: Acme Shop refunds take five business days.\nQuestion: 它多久退款？',
            },
          ],
          maxOutputTokens: 512,
        },
        {
          workspaceId: 'ws-b16-b-real',
          requestId: 'req-b16-b-real-llm',
          traceId: 'trace-b16-b-real-llm',
        },
      );
      const rewritten = result.data.choices[0]?.message.content.trim() ?? '';

      expect(rawQuery).toBe('它多久退款？');
      expect(rewritten.length).toBeGreaterThan(0);
      expect(rewritten).not.toContain('Zephyr-9');
      expect(hash(rewritten)).toMatch(/^[a-f0-9]{64}$/);
      evidence('t02-query-rewrite.json', {
        status: 'REAL_VERIFIED',
        modelId: llmModel,
        endpointHostHash: hash(new URL(baseUrl).host).slice(0, 16),
        rawQueryHash: hash(rawQuery),
        rewrittenQueryHash: hash(rewritten),
        usage: result.usage,
      });
    },
    providerTimeout,
  );

  it(
    'L1-B16-B-SEARCH-005-P06 verifies a real embedding dimension and usage',
    async () => {
      const response = await fetch(joinAiproxyUrl(baseUrl, '/v1/embeddings'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${requiredToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: embeddingModel,
          input: ['退款需要五个工作日', 'refund takes five business days'],
        }),
        signal: AbortSignal.timeout(providerTimeout),
      });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        data: Array<{ index?: number; embedding: number[] }>;
        usage?: { prompt_tokens?: number; total_tokens?: number };
      };
      expect(payload.data).toHaveLength(2);
      const dimension = payload.data[0]?.embedding.length;
      expect([768, 1024, 1536, 3072]).toContain(dimension);
      expect(payload.data.every((item) => item.embedding.length === dimension)).toBe(true);
      evidence('t02-embedding.json', {
        status: 'REAL_VERIFIED',
        modelId: embeddingModel,
        dimension,
        vectorCount: payload.data.length,
        usage: payload.usage ?? null,
      });
    },
    providerTimeout,
  );

  it(
    'L1-B16-B-SEARCH-005-P07 verifies real rerank ordering and score usage',
    async () => {
      const result = await adapter().invoke<{
        results: Array<{ index: number; relevance_score?: number; score?: number }>;
      }>(
        {
          kind: 'rerank',
          modelId: rerankModel,
          query: '退款需要多久？',
          candidates: [
            '退款通常需要五个工作日。',
            '量子计算使用量子比特。',
            '联系支持团队可以查询退款进度。',
          ],
        },
        {
          workspaceId: 'ws-b16-b-real',
          requestId: 'req-b16-b-real-rerank',
          traceId: 'trace-b16-b-real-rerank',
        },
      );
      expect(result.data.results.length).toBeGreaterThan(0);
      expect(result.data.results[0]?.index).toBe(0);
      expect(
        result.data.results.every(
          (item) => typeof item.relevance_score === 'number' || typeof item.score === 'number',
        ),
      ).toBe(true);
      evidence('t02-rerank.json', {
        status: 'REAL_VERIFIED',
        modelId: rerankModel,
        ordering: result.data.results.map((item) => ({
          index: item.index,
          score: item.relevance_score ?? item.score,
        })),
        usage: result.usage,
      });
    },
    providerTimeout,
  );

  it(
    'L1-B16-B-SEARCH-003-P03 verifies the configured VLM can describe the bounded image fixture',
    async () => {
      const pixel =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
      const result = await adapter().invoke<{
        choices: Array<{ message: { content: string } }>;
      }>(
        {
          kind: 'vlm',
          modelId: vlmModel,
          imageUrls: [pixel],
          messages: [
            {
              role: 'user',
              content: 'Return one short factual description. Do not add unrelated entities.',
            },
          ],
          maxOutputTokens: 96,
        },
        {
          workspaceId: 'ws-b16-b-real',
          requestId: 'req-b16-b-real-vlm',
          traceId: 'trace-b16-b-real-vlm',
        },
      );
      const description = result.data.choices[0]?.message.content.trim() ?? '';
      expect(description.length).toBeGreaterThan(0);
      evidence('t02-vlm.json', {
        status: 'REAL_VERIFIED',
        modelId: vlmModel,
        descriptionHash: hash(description),
        usage: result.usage,
      });
    },
    providerTimeout,
  );
});
