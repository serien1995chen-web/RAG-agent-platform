import {
  DeepSearchApiRequestSchema,
  ImageSearchApiRequestSchema,
  type DeepSearchApiRequest,
  type ImageSearchApiRequest,
} from '@kb/contracts';
import { z } from 'zod';

const ObjectId = z.string().regex(/^[a-f0-9]{24}$/);

export const S8SearchFormSchema = z
  .object({
    knowledgeSpaceId: ObjectId,
    knowledgeSpaceIds: z.array(ObjectId).min(1).max(20),
    query: z.string().trim().min(1).max(20_000),
    tokenBudget: z.number().int().min(1).max(20_000).default(12_000),
    roundTokenBudget: z.number().int().min(500).max(20_000).default(5_000),
    maxRounds: z.number().int().min(1).max(3).default(3),
    stopWhenNoNewEvidence: z.boolean().default(true),
    similarity: z.number().min(0).max(1).default(0.2),
    embeddingWeight: z.number().min(0).max(1).default(0.5),
    usingRerank: z.boolean().default(false),
    rerankWeight: z.number().min(0).max(1).default(0.5),
    imageUploadIds: z.array(z.string().min(1)).max(10).default([]),
  })
  .strict();

export type S8SearchFormValues = z.infer<typeof S8SearchFormSchema>;

export function defaultS8SearchForm(
  knowledgeSpaceId: string,
  knowledgeSpaceIds: readonly string[] = [],
): S8SearchFormValues {
  return {
    knowledgeSpaceId,
    knowledgeSpaceIds: [...new Set([knowledgeSpaceId, ...knowledgeSpaceIds])],
    query: '',
    tokenBudget: 12_000,
    roundTokenBudget: 5_000,
    maxRounds: 3,
    stopWhenNoNewEvidence: true,
    similarity: 0.2,
    embeddingWeight: 0.5,
    usingRerank: false,
    rerankWeight: 0.5,
    imageUploadIds: [],
  };
}

export function buildS8DeepRequest(value: S8SearchFormValues): DeepSearchApiRequest {
  return DeepSearchApiRequestSchema.parse({
    knowledgeSpaceId: value.knowledgeSpaceId,
    knowledgeSpaceIds: [...new Set([value.knowledgeSpaceId, ...value.knowledgeSpaceIds])],
    query: value.query,
    tokenBudget: value.tokenBudget,
    maxRounds: value.maxRounds,
    roundTokenBudget: value.roundTokenBudget,
    stopWhenNoNewEvidence: value.stopWhenNoNewEvidence,
    similarity: value.similarity,
    embeddingWeight: value.embeddingWeight,
    usingRerank: value.usingRerank,
    rerankWeight: value.rerankWeight,
  });
}

export function buildS8ImageRequest(value: S8SearchFormValues): ImageSearchApiRequest {
  return ImageSearchApiRequestSchema.parse({
    knowledgeSpaceId: value.knowledgeSpaceId,
    query: value.query,
    tokenBudget: value.tokenBudget,
    imageUploadIds: value.imageUploadIds,
    similarity: value.similarity,
    embeddingWeight: value.embeddingWeight,
    usingRerank: value.usingRerank,
    rerankWeight: value.rerankWeight,
  });
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

export function s8RequestHash(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export class IdempotencyKeyBuffer {
  private hash: string | null = null;
  private key: string | null = null;

  constructor(private readonly createKey: () => string = () => globalThis.crypto.randomUUID()) {}

  keyFor(value: unknown): string {
    const nextHash = s8RequestHash(value);
    if (this.key === null || this.hash !== nextHash) {
      this.hash = nextHash;
      this.key = this.createKey();
    }
    return this.key;
  }
}
