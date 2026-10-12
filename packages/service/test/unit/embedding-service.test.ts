import { describe, expect, it } from 'vitest';
import {
  EMBEDDING_DIMENSION,
  EmbeddingService,
  createUnimplementedEmbeddingGateway,
  type EmbeddingGateway,
} from '../../src/modules/index/application/embedding.service';
import type { RequestContext } from '../../src/ports/types';

const context: RequestContext = {
  requestId: 'req-embedding',
  tenant: { teamId: 'team-a', tmbId: 'tmb-a', authType: 'internal', isRoot: false },
  permission: { canRead: true, canWrite: true, canManage: false, isOwner: false },
};

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
    const gateway: EmbeddingGateway = {
      embed: async (_request, ctx) => {
        expect(ctx.requestId).toBe('req-embedding');
        return [vectorOf(EMBEDDING_DIMENSION)];
      },
    };
    const service = new EmbeddingService({ gateway });
    const result = await service.embed(input, context);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(EMBEDDING_DIMENSION);
  });

  it('rejects a vector count that does not match the text count with 501013', async () => {
    const gateway: EmbeddingGateway = { embed: async () => [] };
    const service = new EmbeddingService({ gateway });
    await expect(service.embed(input, context)).rejects.toMatchObject({
      error: { code: 501013, requestId: 'req-embedding' },
    });
  });

  it('rejects a non-1536 dimension with 501013', async () => {
    const gateway: EmbeddingGateway = { embed: async () => [vectorOf(1024)] };
    const service = new EmbeddingService({ gateway });
    await expect(service.embed(input, context)).rejects.toMatchObject({
      error: { code: 501013, requestId: 'req-embedding' },
    });
  });

  it('returns 501062 when no gateway is injected and carries the caller requestId', async () => {
    const service = new EmbeddingService();
    await expect(service.embed(input, context)).rejects.toMatchObject({
      error: { code: 501062, requestId: 'req-embedding' },
    });
  });

  it('default gateway never fabricates vectors (501062)', async () => {
    const gateway = createUnimplementedEmbeddingGateway();
    await expect(gateway.embed(input, context)).rejects.toMatchObject({ error: { code: 501062 } });
  });

  it('returns the caller-provided stable vector for repeated calls', async () => {
    const stable = vectorOf(EMBEDDING_DIMENSION);
    const gateway: EmbeddingGateway = { embed: async () => [stable] };
    const service = new EmbeddingService({ gateway });
    const first = await service.embed(input, context);
    const second = await service.embed(input, context);
    expect(first).toEqual(second);
    expect(first[0]).toEqual(stable);
  });
});
