import { ApiErrorException, createApiError } from '@kb/contracts';
import type { ModelSelection } from '@kb/contracts';
import type { ModelCapability, ModelRegistryPort } from '../../../ports/capabilities';
import type { PortCallOptions, RequestContext } from '../../../ports/types';
import { assertMockModeAllowed } from '../../../shared/config';

/** 在线 embedding 维度固定 1536（设计文档 6.4 / 6.1.10）；维度不一致 → 501013。 */
export const ONLINE_EMBEDDING_DIMENSION = 1536 as const;

/** 设计文档 11.2 / 11.5：可探测的模型能力种类。 */
export const MODEL_CAPABILITY_KINDS = ['embedding', 'llm', 'vlm', 'rerank'] as const;
export type ModelCapabilityKind = (typeof MODEL_CAPABILITY_KINDS)[number];

/** U-09/U-10 条件执行的模型网关扩展点；未注入时按 mockMode 处理（生产 + mock → 501063）。 */
export interface ModelCapabilityGateway {
  probe(
    input: { modelId: string; capability: ModelCapabilityKind; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ dimension: number; capabilities: string[] }>;
}

export interface ModelRegistryAdapterDeps {
  environment: string;
  mockMode: 'mock' | 'real';
  models: readonly ModelSelection[];
  gateway?: ModelCapabilityGateway;
}

interface ModelEntry {
  modelId: string;
  capability: ModelCapabilityKind;
}

function entriesOf(selection: ModelSelection): ModelEntry[] {
  const entries: ModelEntry[] = [{ modelId: selection.embeddingModel, capability: 'embedding' }];
  if (selection.llmModel !== undefined) {
    entries.push({ modelId: selection.llmModel, capability: 'llm' });
  }
  if (selection.vlmModel !== undefined) {
    entries.push({ modelId: selection.vlmModel, capability: 'vlm' });
  }
  if (selection.rerankModel !== undefined) {
    entries.push({ modelId: selection.rerankModel, capability: 'rerank' });
  }
  return entries;
}

function error(
  context: RequestContext,
  code: number,
  params: Record<string, unknown>,
): ApiErrorException {
  return new ApiErrorException(createApiError({ code, requestId: context.requestId, params }));
}

/**
 * 模型能力探测适配器（P5-03）。
 * - 能力缓存以 `modelId+capability` 为键；**不缓存权限**。
 * - 维度 ≠ 1536 → 501013；未配置依赖 → 501062；生产环境 mockMode 命中 → 501063。
 */
export function createModelRegistryAdapter(deps: ModelRegistryAdapterDeps): ModelRegistryPort {
  const configured = new Map<string, ModelCapabilityKind>();
  for (const selection of deps.models) {
    for (const entry of entriesOf(selection)) {
      if (!configured.has(entry.modelId)) configured.set(entry.modelId, entry.capability);
    }
  }
  const capabilityCache = new Map<string, ModelCapability>();

  function guard(context: RequestContext): void {
    assertMockModeAllowed({
      dependency: 'model',
      mode: deps.mockMode,
      environment: deps.environment,
      requestId: context.requestId,
    });
  }

  async function resolve(
    modelId: string,
    options: PortCallOptions,
    context: RequestContext,
    fresh: boolean,
  ): Promise<ModelCapability> {
    guard(context);
    const capability = configured.get(modelId);
    if (capability === undefined) {
      throw error(context, 501062, { dependency: 'model_registry' });
    }
    const key = `${modelId}:${capability}`;
    if (!fresh) {
      const cached = capabilityCache.get(key);
      if (cached !== undefined) return cached;
    }
    let probed: { dimension: number; capabilities: string[] };
    if (deps.gateway !== undefined) {
      probed = await deps.gateway.probe({ modelId, capability, options }, context);
    } else if (deps.mockMode === 'mock') {
      probed = {
        dimension: capability === 'embedding' ? ONLINE_EMBEDDING_DIMENSION : 0,
        capabilities: [capability],
      };
    } else {
      throw error(context, 501062, { dependency: 'model_gateway' });
    }
    if (capability === 'embedding' && probed.dimension !== ONLINE_EMBEDDING_DIMENSION) {
      throw error(context, 501013, {
        expected: ONLINE_EMBEDDING_DIMENSION,
        actual: probed.dimension,
      });
    }
    const resolved: ModelCapability = {
      modelId,
      dimension: probed.dimension,
      capabilities: probed.capabilities,
    };
    capabilityCache.set(key, resolved);
    return resolved;
  }

  return {
    async listModels(input, context): Promise<ModelSelection[]> {
      guard(context);
      return deps.models.filter((selection) =>
        entriesOf(selection).some((entry) => entry.capability === input.capability),
      );
    },
    getCapability(input, context): Promise<ModelCapability> {
      return resolve(input.modelId, input.options, context, false);
    },
    probe(input, context): Promise<ModelCapability> {
      return resolve(input.modelId, input.options, context, true);
    },
  };
}
