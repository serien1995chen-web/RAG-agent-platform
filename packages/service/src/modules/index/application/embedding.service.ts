import { ApiErrorException, createApiError } from '@kb/contracts';
import type { ModelSelection } from '@kb/contracts';
import type { PortCallOptions, RequestContext } from '../../../ports/types';

/** 在线 embedding 维度固定为 1536（设计文档 6.4 / 6.1.10）。 */
export const EMBEDDING_DIMENSION = 1536 as const;

export interface EmbeddingRequest {
  models: ModelSelection;
  texts: string[];
  options: PortCallOptions;
}

/**
 * Embedding 应用层内部扩展点（非公开 Port）。
 * 不加入 ServicePorts / DEFAULT_PORT_IDS / 38 公开 Port 口径。
 */
export interface EmbeddingGateway {
  embed(request: EmbeddingRequest, context: RequestContext): Promise<number[][]>;
}

/** 默认未接入：调用即返回既有错误码 501062，禁止哈希 / 随机数 / 本地伪向量。 */
export function createUnimplementedEmbeddingGateway(): EmbeddingGateway {
  return {
    async embed(_request: EmbeddingRequest, context: RequestContext): Promise<number[][]> {
      throw new ApiErrorException(
        createApiError({
          code: 501062,
          requestId: context.requestId,
          params: { dependency: 'embedding_gateway' },
        }),
      );
    },
  };
}

/**
 * 开发/演示用确定性 mock 网关（`KB_EXTERNAL_MOCK_MODE.model=mock`）。
 *
 * 与真实 Provider 的边界保持一致：只在本机计算，不出网；同一文本永远得到同一向量，
 * 因此同一份数据写入后可以被检索命中。生产环境必须显式关闭（默认即未接入）。
 */
export function createMockEmbeddingGateway(): EmbeddingGateway {
  return {
    async embed(request: EmbeddingRequest, _context: RequestContext): Promise<number[][]> {
      return request.texts.map((text) => mockVector(text));
    },
  };
}

function mockVector(text: string): number[] {
  // FNV-1a 生成 32 位种子，再用线性同余发生器铺满 1536 维并归一化。
  let seed = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    seed ^= text.charCodeAt(i);
    seed = Math.imul(seed, 16777619) >>> 0;
  }
  const vector: number[] = new Array(EMBEDDING_DIMENSION);
  let state = seed || 1;
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIMENSION; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const value = state / 4294967296 - 0.5;
    vector[i] = value;
    norm += value * value;
  }
  const scale = norm === 0 ? 1 : 1 / Math.sqrt(norm);
  return vector.map((value) => value * scale);
}

export interface EmbeddingServiceDeps {
  gateway?: EmbeddingGateway;
}

/**
 * Embedding 内部入口：把网关返回的向量收敛为固定 1536 维契约。
 * 向量数量与文本数量不一致或维度不一致返回 501013；网关未注入返回 501062。
 * 传入 RequestContext 以保证 teamId / requestId / 权限上下文可审计。
 */
export class EmbeddingService {
  private readonly gateway: EmbeddingGateway;

  constructor(deps: EmbeddingServiceDeps = {}) {
    this.gateway = deps.gateway ?? createUnimplementedEmbeddingGateway();
  }

  async embed(input: EmbeddingRequest, context: RequestContext): Promise<number[][]> {
    const vectors = await this.gateway.embed(input, context);
    if (vectors.length !== input.texts.length) {
      throw new ApiErrorException(
        createApiError({
          code: 501013,
          requestId: context.requestId,
          params: { expected: input.texts.length, actual: vectors.length },
        }),
      );
    }
    for (const vector of vectors) {
      if (vector.length !== EMBEDDING_DIMENSION) {
        throw new ApiErrorException(
          createApiError({
            code: 501013,
            requestId: context.requestId,
            params: { expected: EMBEDDING_DIMENSION, actual: vector.length },
          }),
        );
      }
    }
    return vectors;
  }
}
