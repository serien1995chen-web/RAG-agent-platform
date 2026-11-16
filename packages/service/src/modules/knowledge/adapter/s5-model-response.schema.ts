import { z } from 'zod';
import type {
  S5ModelType,
  S5UsageUnit,
  S5VectorDimension,
} from '../application/s5-model-gateway.port';

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

const RerankResultSchema = z
  .object({
    index: z.number().int().min(0),
    relevance_score: z.number().finite().optional(),
    score: z.number().finite().optional(),
  })
  .passthrough()
  .superRefine((value, context) => {
    if (value.relevance_score === undefined && value.score === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['relevance_score'],
        message: 'at least one score is required',
      });
    }
  });

const RerankResponseSchema = z
  .object({
    results: z.array(RerankResultSchema).superRefine((results, context) => {
      const seen = new Set<number>();
      results.forEach((result, position) => {
        if (seen.has(result.index)) {
          context.addIssue({
            code: 'custom',
            path: [position, 'index'],
            message: 'duplicate candidate index',
          });
        }
        seen.add(result.index);
      });
    }),
    usage: UsageSchema,
  })
  .passthrough();

const SttResponseSchema = z
  .object({
    text: z.string(),
    duration: z.number().finite().min(0).optional(),
    duration_seconds: z.number().finite().min(0).optional(),
    usage: UsageSchema,
  })
  .passthrough();

const NativeTtsResponseSchema = z
  .object({
    audioUrl: z.string().url().optional(),
    audio: z.instanceof(Uint8Array).optional(),
    mimeType: z.string().min(1),
    usageCharacters: z.number().int().min(0).optional(),
  })
  .refine((value) => value.audioUrl !== undefined || value.audio !== undefined, {
    message: 'audio payload is required',
  });

export interface ParsedModelResponse {
  data: unknown;
  usage: { inputTokens: number; outputTokens: number };
  quantity: number;
  quantityUnit?: S5UsageUnit;
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
  durationSeconds?: number;
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
      const usage = tokenUsage(parsed.data.usage);
      return {
        data: parsed.data,
        usage,
        quantity: parsed.data.duration_seconds ?? parsed.data.duration ?? 0,
      };
    }
    case 'tts': {
      if (input.data instanceof Uint8Array || input.data instanceof ArrayBuffer) {
        return {
          data: input.data,
          usage: { inputTokens: 0, outputTokens: 0 },
          quantity:
            typeof input.durationSeconds === 'number' &&
            Number.isFinite(input.durationSeconds) &&
            input.durationSeconds >= 0
              ? input.durationSeconds
              : 0,
          quantityUnit: 'second',
        };
      }
      const parsed = NativeTtsResponseSchema.safeParse(input.data);
      if (!parsed.success) throw parseFailure();
      return {
        data: parsed.data,
        usage: { inputTokens: 0, outputTokens: 0 },
        quantity: parsed.data.usageCharacters ?? 0,
        quantityUnit: 'character',
      };
    }
  }
}
