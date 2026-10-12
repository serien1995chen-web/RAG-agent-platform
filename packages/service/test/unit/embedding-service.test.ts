import { describe, expect, it } from 'vitest';
import {
  EMBEDDING_DIMENSION,
  EmbeddingService,
  createUnimplementedEmbeddingGateway,
  type EmbeddingGateway,
} from '../../src/modules/index/application/embedding.service';

const input = {
  models: { embeddingModel: 'bge-m3' },
  texts: ['hello world'],
  options: { timeoutMs: 5000 },
};

function vectorOf(dimension: number): number[] {
  return new Array<number>(dimension).fill(0.25);
}

describe('EmbeddingService（BASE-B3 内部入口）', () => {
  it('returns 1536-dim vectors from the injected gateway', async () => {
    const gateway: EmbeddingGateway = { embed: async () => [vectorOf(EMBEDDING_DIMENSION)] };
    const service = new EmbeddingService({ gateway });
    const result = await service.embed(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(EMBEDDING_DIMENSION);
  });

  it('rejects a non-1536 dimension with 501013', async () => {
    const gateway: EmbeddingGateway = { embed: async () => [vectorOf(1024)] };
    const service = new EmbeddingService({ gateway });
    await expect(service.embed(input)).rejects.toMatchObject({ error: { code: 501013 } });
  });

  it('returns 501062 when no gateway is injected', async () => {
    const service = new EmbeddingService();
    await expect(service.embed(input)).rejects.toMatchObject({ error: { code: 501062 } });
  });

  it('default gateway never fabricates vectors (501062)', async () => {
    const gateway = createUnimplementedEmbeddingGateway();
    await expect(gateway.embed(input)).rejects.toMatchObject({ error: { code: 501062 } });
  });

  it('returns the caller-provided stable vector for repeated calls', async () => {
    const stable = vectorOf(EMBEDDING_DIMENSION);
    const gateway: EmbeddingGateway = { embed: async () => [stable] };
    const service = new EmbeddingService({ gateway });
    const first = await service.embed(input);
    const second = await service.embed(input);
    expect(first).toEqual(second);
    expect(first[0]).toEqual(stable);
  });
});
