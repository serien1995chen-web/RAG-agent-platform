import { z } from 'zod';
import type { S5ModelType, S5VectorDimension } from '../application/s5-model-gateway.port';

const UsageSchema = z
  .object({
    prompt_tokens: z.number().int().min(0).optional(),
    completion_tokens: z.number().int().min(0).optional(),
    total_tokens: z.number().int().min(0).optional(),
  })
  .passthrough()
  .optional();

const ChatResponseSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            message: z.object({ content: z.string() }).passthrough(),
          })
          .passthrough(),
      )
      .min(1),
    usage: UsageSchema,
  })
  .passthrough();

const EmbeddingResponseSchema = z
  .object({
    data: z.array(
      z
        .object({
          index: z.number().int().min(0).optional(),
          embedding: z.array(z.number().finite()),
        })
        .passthrough(),
    ),
    usage: UsageSchema,
  })
  .passthrough();

const RerankResponseSchema = z
  .object({
    results: z.array(
      z
        .object({
          index: z.number().int().min(0),
          relevance_score: z.number().finite().optional(),
          score: z.number().finite().optional(),
        })
        .passthrough(),
    ),
    usage: UsageSchema,
  })
  .passthrough();

const SttResponseSchema = z.object({ text: z.string() }).passthrough();

export interface ParsedModelResponse {
  data: unknown;
  usage: { inputTokens: number; outputTokens: number };
  quantity: number;
}

export class S5ModelResponseContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'S5ModelResponseContractError';
  }
}

function tokenUsage(value: z.infer<typeof UsageSchema>): {
  inputTokens: number;
  outputTokens: number;
} {
  return {
    inputTokens: value?.prompt_tokens ?? 0,
    outputTokens: value?.completion_tokens ?? 0,
  };
}

function parseFailure(): S5ModelResponseContractError {
  return new S5ModelResponseContractError('model_response_schema_invalid');
}

export function parseModelResponse(input: {
  kind: S5ModelType;
  data: unknown;
  dimension?: S5VectorDimension;
  inputText?: string;
}): ParsedModelResponse {
  switch (input.kind) {
    case 'llm':
    case 'vlm': {
      const parsed = ChatResponseSchema.safeParse(input.data);
      if (!parsed.success) throw parseFailure();
      const usage = tokenUsage(parsed.data.usage);
      return {
        data: parsed.data,
        usage,
        quantity: usage.inputTokens + usage.outputTokens,
      };
    }
    case 'embedding': {
      const parsed = EmbeddingResponseSchema.safeParse(input.data);
      if (!parsed.success) throw parseFailure();
      if (parsed.data.data.some((item) => item.embedding.length !== input.dimension)) {
        throw new S5ModelResponseContractError('embedding_dimension_mismatch');
      }
      const usage = tokenUsage(parsed.data.usage);
      return {
        data: parsed.data,
        usage,
        quantity: usage.inputTokens || 0,
      };
    }
    case 'rerank': {
      const parsed = RerankResponseSchema.safeParse(input.data);
      if (!parsed.success) throw parseFailure();
      const usage = tokenUsage(parsed.data.usage);
      return {
        data: parsed.data,
        usage,
        quantity: usage.inputTokens,
      };
    }
    case 'stt': {
      const parsed = SttResponseSchema.safeParse(input.data);
      if (!parsed.success) throw parseFailure();
      return {
        data: parsed.data,
        usage: { inputTokens: 0, outputTokens: 0 },
        quantity: 0,
      };
    }
    case 'tts': {
      if (!(input.data instanceof Uint8Array) && !(input.data instanceof ArrayBuffer)) {
        throw parseFailure();
      }
      return {
        data: input.data,
        usage: { inputTokens: 0, outputTokens: 0 },
        quantity: [...(input.inputText ?? '')].length,
      };
    }
  }
}
