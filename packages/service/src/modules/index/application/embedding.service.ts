import { ApiErrorException, createApiError } from '@kb/contracts';
import type { ModelSelection } from '@kb/contracts';
import type { PortCallOptions } from '../../../ports/types';

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
  embed(request: EmbeddingRequest): Promise<number[][]>;
}

/** 默认未接入：调用即返回既有错误码 501062，禁止哈希 / 随机数 / 本地伪向量。 */
export function createUnimplementedEmbeddingGateway(): EmbeddingGateway {
  return {
    async embed(): Promise<number[][]> {
      throw new ApiErrorException(
        createApiError({
          code: 501062,
          requestId: 'embedding-service',
          params: { dependency: 'embedding_gateway' },
        }),
      );
    },
  };
}

export interface EmbeddingServiceDeps {
  gateway?: EmbeddingGateway;
}

/**
 * Embedding 内部入口：把网关返回的向量收敛为固定 1536 维契约。
 * 维度不一致返回 501013；网关未注入返回 501062。
 */
export class EmbeddingService {
  private readonly gateway: EmbeddingGateway;

  constructor(deps: EmbeddingServiceDeps = {}) {
    this.gateway = deps.gateway ?? createUnimplementedEmbeddingGateway();
  }

  async embed(input: EmbeddingRequest): Promise<number[][]> {
    const vectors = await this.gateway.embed(input);
    for (const vector of vectors) {
      if (vector.length !== EMBEDDING_DIMENSION) {
        throw new ApiErrorException(
          createApiError({
            code: 501013,
            requestId: 'embedding-service',
            params: { expected: EMBEDDING_DIMENSION, actual: vector.length },
          }),
        );
      }
    }
    return vectors;
  }
}
