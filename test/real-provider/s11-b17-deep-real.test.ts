import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AxiosS5HttpTransport,
  S5AiproxyHttpAdapter,
} from '../../packages/service/src/modules/knowledge/adapter/s5-aiproxy-http.adapter';
import { DeepPlannerOutputSchema, type DeepPlannerOutput } from '../../packages/contracts/src';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const baseUrl = process.env.AIPROXY_BASE_URL?.trim() || 'https://tokendance.space/gateway/v1';
const token = process.env.AIPROXY_API_TOKEN?.trim();
const llmModel = process.env.S11_AIPROXY_LLM_MODEL?.trim() || 'qwen3.7-plus';
const embeddingModel = process.env.S11_AIPROXY_EMBEDDING_MODEL?.trim() || 'qwen3.7-text-embedding';
const rerankModel = process.env.S11_AIPROXY_RERANK_MODEL?.trim() || 'qwen3.7-text-rerank';
const vlmModel = process.env.S11_AIPROXY_VLM_MODEL?.trim() || 'kimi-k2.5';
const timeoutMs = 120_000;

const context: TenantContext = {
  workspaceId: 'ws_b17_real_provider',
  memberId: 'mem_b17_real_provider',
  requestId: 'req_b17_real_provider',
  traceId: 'b17-real-provider-trace-00000000',
  scopes: ['knowledge:search'],
  isWorkspaceOwner: true,
};

function requiredToken() {
  if (!token) throw new Error('S11_PROVIDER_REAL_BLOCKED: missing AIPROXY_API_TOKEN');
  return token;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function evidencePath(name: string) {
  const directory =
    process.env.B17_PROVIDER_EVIDENCE_DIR?.trim() ||
    resolve(process.cwd(), 'test-results/b17/b17-20261121-152033/provider');
  mkdirSync(directory, { recursive: true });
  return join(directory, name);
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

describe('L1-B17-SEARCH-008 real TokenDance Provider', () => {
  it(
    'L1-B17-SEARCH-008-P01 exercises real LLM planner, embedding, rerank and VLM roles',
    async () => {
      const client = adapter();
      const planner = await client.invoke<{
        choices: Array<{ message: { content: string } }>;
      }>(
        {
          kind: 'llm',
          modelId: llmModel,
          messages: [
            {
              role: 'system',
              content:
                'Return only JSON with queries, an array of 1 to 5 concise search queries, and sufficient, a boolean.',
            },
            {
              role: 'user',
              content:
                'Question: Compare refund handling and escalation ownership across support policies. Evidence: Refunds take five business days. Escalation belongs to support operations.',
            },
          ],
          maxOutputTokens: 512,
        },
        context,
      );
      const rawPlanner = planner.data.choices[0]?.message.content ?? '';
      let parsedPlanner: unknown;
      try {
        parsedPlanner = JSON.parse(rawPlanner);
      } catch {
        parsedPlanner = null;
      }
      const plannerData = DeepPlannerOutputSchema.parse(parsedPlanner);

      const embedding = await client.invoke<{
        data: Array<{ index?: number; embedding: number[] }>;
      }>(
        {
          kind: 'embedding',
          modelId: embeddingModel,
          input: [
            { type: 'text', text: 'refund handling policy' },
            { type: 'text', text: 'escalation ownership' },
          ],
          dimension: 1024,
        },
        context,
      );
      expect(embedding.data.data).toHaveLength(2);
      const dimension = embedding.data.data[0]?.embedding.length ?? 0;
      expect([768, 1024, 1536, 3072]).toContain(dimension);
      expect(embedding.data.data.every((item) => item.embedding.length === dimension)).toBe(true);

      const rerank = await client.invoke<{
        results: Array<{ index: number; relevance_score?: number; score?: number }>;
      }>(
        {
          kind: 'rerank',
          modelId: rerankModel,
          query: 'How long does a refund take?',
          candidates: [
            'Refunds take five business days.',
            'Quantum computers use qubits.',
            'Support operations owns escalation.',
          ],
        },
        context,
      );
      expect(rerank.data.results[0]?.index).toBe(0);

      const pixel =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
      const vlm = await client.invoke<{
        choices: Array<{ message: { content: string } }>;
      }>(
        {
          kind: 'vlm',
          modelId: vlmModel,
          messages: [
            {
              role: 'user',
              content: 'Return one short factual description of the supplied image only.',
            },
          ],
          imageUrls: [pixel],
          maxOutputTokens: 96,
        },
        context,
      );
      const vlmText = vlm.data.choices[0]?.message.content.trim() ?? '';
      expect(vlmText.length).toBeGreaterThan(0);

      const result: {
        modelIds: Record<string, string>;
        planner: DeepPlannerOutput;
        embeddingDimension: number;
        usage: Record<string, unknown>;
        requestIds: string[];
        responseHashes: Record<string, string>;
      } = {
        modelIds: {
          llm: llmModel,
          embedding: embeddingModel,
          rerank: rerankModel,
          vlm: vlmModel,
        },
        planner: plannerData,
        embeddingDimension: dimension,
        usage: {
          llm: planner.usage,
          embedding: embedding.usage,
          rerank: rerank.usage,
          vlm: vlm.usage,
        },
        requestIds: [planner.requestId, embedding.requestId, rerank.requestId, vlm.requestId],
        responseHashes: {
          planner: hash(rawPlanner),
          embedding: hash(JSON.stringify(embedding.data.data.map((item) => item.index))),
          rerank: hash(JSON.stringify(rerank.data.results)),
          vlm: hash(vlmText),
        },
      };
      writeFileSync(
        evidencePath('b17-provider.json'),
        `${JSON.stringify(
          {
            status: 'REAL_VERIFIED',
            endpointHostHash: hash(new URL(baseUrl).host).slice(0, 16),
            ...result,
          },
          null,
          2,
        )}\n`,
      );
    },
    timeoutMs,
  );
});
