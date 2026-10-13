import { ApiErrorException, createApiError } from '@kb/contracts';
import type { SearchEngineDeps } from '@kb/search';
import { assertMockModeAllowed } from '../../../shared/config';

/** 与 A 已冻结的 `SearchEngineDeps.rerank` 形状逐字段一致，禁止新增第二套签名。 */
export type RerankPort = NonNullable<SearchEngineDeps['rerank']>;

/** U-09/U-10 条件执行的 rerank 模型网关扩展点。 */
export interface RerankGateway {
  rerank(
    input: {
      model: string;
      items: { id: string; score: number }[];
      options: { timeoutMs: number };
    },
    context: { requestId: string; tenant: { teamId: string; tmbId: string } },
  ): Promise<{ id: string; score: number }[]>;
}

export interface RerankAdapterDeps {
  environment: string;
  mockMode: 'mock' | 'real';
  gateway?: RerankGateway;
}

/**
 * Rerank 适配器（P5-03）。
 * - 429/5xx/timeout 归类为可重试失败并原样抛出交由引擎处理；Provider 明确拒绝不重试。
 * - 未注入网关时按 mockMode 处理：mock（且非生产）返回确定性结果；real 未配置 → 501062。
 * - 生产环境 + mockMode → 501063，且不发起任何请求。
 */
export function createRerankAdapter(deps: RerankAdapterDeps): RerankPort {
  return {
    async rerank(input, context) {
      assertMockModeAllowed({
        dependency: 'model',
        mode: deps.mockMode,
        environment: deps.environment,
        requestId: context.requestId,
      });
      if (deps.gateway !== undefined) {
        return deps.gateway.rerank(input, context);
      }
      if (deps.mockMode === 'mock') {
        return [...input.items]
          .sort((left, right) => right.score - left.score)
          .map((item) => ({ id: item.id, score: item.score }));
      }
      throw new ApiErrorException(
        createApiError({
          code: 501062,
          requestId: context.requestId,
          params: { dependency: 'model_rerank' },
        }),
      );
    },
  };
}
