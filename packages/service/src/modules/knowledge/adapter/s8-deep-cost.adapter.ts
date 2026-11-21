import { createKnowledgeError } from '@kb/contracts';
import type { S10PricingProfile } from '../../../shared/config/s10-profiles';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import { computeUsagePointsMicros } from '../domain/s10-usage';
import type { S10ModelQuotaPort } from '../application/s5-model-gateway.port';
import type { S8DeepCostPort } from '../application/s8-image-deep.ports';

export class S8DeepCostAdapter implements S8DeepCostPort {
  readonly pricingVersion: string;

  constructor(
    private readonly input: {
      pricing: S10PricingProfile;
      quota: S10ModelQuotaPort;
    },
  ) {
    this.pricingVersion = input.pricing.version;
  }

  async availablePointsMicros(context: TenantContext): Promise<number> {
    if (!this.input.quota.availableAiPointsMicros) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_INTERNAL_ERROR',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { reason: 'deep_cost_quota_unavailable' },
      });
    }
    return this.input.quota.availableAiPointsMicros(context);
  }

  llmPointsMicros(inputTokens: number, outputTokens: number): number {
    return computeUsagePointsMicros({
      kind: 'llm',
      status: 200,
      intent: false,
      quantity: inputTokens + outputTokens,
      unit: 'token',
      inputTokens,
      outputTokens,
      pricing: this.input.pricing,
    });
  }

  embeddingPointsMicros(inputTokens: number): number {
    return computeUsagePointsMicros({
      kind: 'embedding',
      status: 200,
      intent: false,
      quantity: inputTokens,
      unit: 'token',
      inputTokens,
      pricing: this.input.pricing,
    });
  }

  rerankPointsMicros(inputTokens: number): number {
    return computeUsagePointsMicros({
      kind: 'rerank',
      status: 200,
      intent: false,
      quantity: inputTokens,
      unit: 'token',
      inputTokens,
      pricing: this.input.pricing,
    });
  }
}
