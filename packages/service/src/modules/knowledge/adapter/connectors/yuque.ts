import { providerConfigError } from '../provider-json';
import { MockCloudConnectorClient } from './common';
import type { CloudProviderClientPort } from '../../application/ingestion.ports';
import type { TenantContext } from '../../../../shared/persistence/knowledge/tenant';

export class YuqueConnectorClient {
  constructor(
    private readonly delegate: CloudProviderClientPort = new MockCloudConnectorClient(),
  ) {}

  catalog(input: {
    config: Record<string, unknown>;
    credentials: Record<string, unknown>;
    rootId: string;
    context: TenantContext;
  }) {
    if (input.config.provider !== 'yuque') {
      providerConfigError('yuque', input.context, 'provider_mismatch');
    }
    return this.delegate.catalog({ ...input, provider: 'yuque' });
  }

  content(input: {
    config: Record<string, unknown>;
    credentials: Record<string, unknown>;
    externalIds: readonly string[];
    context: TenantContext;
  }) {
    return this.delegate.content({ ...input, provider: 'yuque' });
  }
}
