import { createKnowledgeError } from '@kb/contracts';
import type { ReferenceRegistryDescriptor, ReferenceRegistryPort } from '../application/ports';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import { EXTERNAL_UNVERIFIED } from './external-providers';

export class MockReferenceRegistryAdapter implements ReferenceRegistryPort {
  private readonly entries = new Map<string, ReferenceRegistryDescriptor>();

  register(input: Omit<ReferenceRegistryDescriptor, 'verification'>): void {
    this.entries.set(`${input.referrerType}:${input.referrerId}:${input.referrerVersion}`, {
      ...input,
      verification: EXTERNAL_UNVERIFIED,
    });
  }

  seed(entries: readonly Omit<ReferenceRegistryDescriptor, 'verification'>[]): void {
    for (const entry of entries) this.register(entry);
  }

  resolve(
    referrerType: 'app' | 'workflow',
    referrerId: string,
    referrerVersion: string,
    context: TenantContext,
  ): ReferenceRegistryDescriptor {
    const entry = this.entries.get(`${referrerType}:${referrerId}:${referrerVersion}`);
    if (!entry) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        requestId: context.requestId,
        traceId: context.traceId,
        details: {
          field: 'referrer',
          reason: 'unregistered_reference',
          verification: EXTERNAL_UNVERIFIED,
        },
      });
    }
    return entry;
  }
}
