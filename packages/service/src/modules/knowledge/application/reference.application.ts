import type { AccessPort, ReferenceEventPort, ReferencePort, ReferenceRegistryPort } from './ports';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';

export class ReferenceApplication {
  constructor(
    private readonly references: ReferencePort,
    private readonly registry: ReferenceRegistryPort,
    private readonly access: AccessPort,
  ) {}

  async list(spaceId: string, context: TenantContext) {
    await this.access.assertPermission('space', spaceId, 'read', context);
    return this.references.list(spaceId, context);
  }

  async upsert(
    input: {
      spaceId: string;
      referrerType: 'app' | 'workflow';
      referrerId: string;
      referrerVersion: string;
      registryRevision: number;
    },
    context: TenantContext,
  ) {
    const descriptor = this.registry.resolve(
      input.referrerType,
      input.referrerId,
      input.referrerVersion,
      context,
    );
    return (this.references as ReferenceEventPort).applyUpsert(
      {
        ...input,
        referrerName: descriptor.referrerName,
      },
      context,
    );
  }

  remove(
    input: {
      spaceId: string;
      referrerType: 'app' | 'workflow';
      referrerId: string;
      referrerVersion: string;
      registryRevision: number;
    },
    context: TenantContext,
  ) {
    return (this.references as ReferenceEventPort).applyRemove(input, context);
  }
}
