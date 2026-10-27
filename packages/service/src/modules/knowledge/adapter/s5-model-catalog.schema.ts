import { z } from 'zod';
import {
  S5_MODEL_TYPES,
  S5_VECTOR_DIMENSIONS,
  type ModelCatalogItem,
  type S5ModelType,
  type S5VectorDimension,
} from '../application/s5-model-ports';

const DimensionSchema = z.union([
  z.literal(768),
  z.literal(1024),
  z.literal(1536),
  z.literal(3072),
]);

const CatalogItemSchema = z
  .object({
    id: z.string().min(1).max(256),
    display_name: z.string().min(1).max(256).optional(),
    displayName: z.string().min(1).max(256).optional(),
    type: z.enum(S5_MODEL_TYPES),
    capabilities: z.array(z.string().min(1).max(128)),
    dimension: z.number().int().optional(),
  })
  .passthrough();

export const S5AiproxyCatalogEnvelopeSchema = z
  .object({
    data: z.array(CatalogItemSchema),
  })
  .passthrough();

export class S5ModelCatalogContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'S5ModelCatalogContractError';
  }
}

function dimensionFrom(item: z.infer<typeof CatalogItemSchema>): S5VectorDimension | null {
  if (item.type !== 'embedding') return null;
  const candidates: unknown[] = [
    item.dimension,
    ...item.capabilities
      .filter((capability) => capability.startsWith('dimension:'))
      .map((capability) => Number(capability.slice('dimension:'.length))),
  ];
  for (const candidate of candidates) {
    const parsed = DimensionSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  return null;
}

export function normalizeCatalog(
  envelope: z.infer<typeof S5AiproxyCatalogEnvelopeSchema>,
): ModelCatalogItem[] {
  return envelope.data
    .map((item) => {
      const type = item.type as S5ModelType;
      const dimension = dimensionFrom(item);
      if (type === 'embedding' && dimension === null) {
        throw new S5ModelCatalogContractError('embedding_dimension_missing');
      }
      return {
        modelId: item.id,
        displayName: item.displayName ?? item.display_name ?? item.id,
        type,
        capabilities: [...new Set(item.capabilities)].sort(),
        dimension,
        authorized: true,
      } satisfies ModelCatalogItem;
    })
    .sort((left, right) => {
      const typeOrder = S5_MODEL_TYPES.indexOf(left.type) - S5_MODEL_TYPES.indexOf(right.type);
      return typeOrder === 0 ? left.modelId.localeCompare(right.modelId) : typeOrder;
    });
}

export function hasValidVectorDimension(value: number): value is S5VectorDimension {
  return (S5_VECTOR_DIMENSIONS as readonly number[]).includes(value);
}
