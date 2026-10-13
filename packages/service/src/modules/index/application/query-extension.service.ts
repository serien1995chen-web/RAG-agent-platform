import type { PortCallOptions, RequestContext } from '../../../ports/types';

/** U-09/U-10 条件执行的 Query Extension 网关扩展点（设计文档 11.2）。 */
export interface QueryExtensionGateway {
  extend(
    input: { query: string; histories: readonly string[]; model: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ query: string }>;
}

export interface QueryExtensionServiceDeps {
  gateway?: QueryExtensionGateway;
  model?: string;
  timeoutMs?: number;
}

export interface QueryExtensionInput {
  query: string;
  histories?: readonly string[];
}

export interface QueryExtensionResult {
  query: string;
  degraded: boolean;
  reason?: string;
}

/**
 * Query Extension 应用服务（P5-03）。
 * 失败 / 超时 / 输出 schema 错误一律**返回原 Query**；扩展结果只产出查询文本，
 * 不携带任何 dataset / team 过滤范围，因此不会扩大过滤范围；不写持久业务数据。
 */
export class QueryExtensionService {
  constructor(private readonly deps: QueryExtensionServiceDeps = {}) {}

  async extend(input: QueryExtensionInput, context: RequestContext): Promise<QueryExtensionResult> {
    const gateway = this.deps.gateway;
    const model = this.deps.model;
    if (gateway === undefined || model === undefined) {
      return { query: input.query, degraded: true, reason: 'query_extension_not_configured' };
    }
    try {
      const extended = await gateway.extend(
        {
          query: input.query,
          histories: input.histories ?? [],
          model,
          options: { timeoutMs: this.deps.timeoutMs ?? 3_000 },
        },
        context,
      );
      const query = typeof extended?.query === 'string' ? extended.query : '';
      if (query.trim().length === 0) {
        return { query: input.query, degraded: true, reason: 'query_extension_schema_invalid' };
      }
      return { query, degraded: false };
    } catch (caught) {
      return {
        query: input.query,
        degraded: true,
        reason: caught instanceof Error ? caught.message : String(caught),
      };
    }
  }
}
