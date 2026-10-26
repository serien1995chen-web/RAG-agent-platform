import { providerConfigError } from '../provider-json';
import { MockCloudConnectorClient } from './common';
import type { CloudProviderClientPort } from '../../application/ingestion.ports';
import type { TenantContext } from '../../../../shared/persistence/knowledge/tenant';

export class FeishuConnectorClient {
  constructor(
    private readonly delegate: CloudProviderClientPort = new MockCloudConnectorClient(),
  ) {}

  catalog(input: {
    config: Record<string, unknown>;
    credentials: Record<string, unknown>;
    rootId: string;
    cursor?: string;
    context: TenantContext;
  }) {
    if (input.config.provider !== 'feishu' || typeof input.config.folderToken !== 'string') {
      providerConfigError('feishu', input.context, 'folderToken_required');
    }
    return this.delegate.catalog({ ...input, provider: 'feishu' });
  }

  get tokenRefreshCount(): number {
    return this.delegate instanceof MockCloudConnectorClient ? this.delegate.tokenRefreshCount : 0;
  }

  content(input: {
    config: Record<string, unknown>;
    credentials: Record<string, unknown>;
    externalIds: readonly string[];
    context: TenantContext;
  }) {
    return this.delegate.content({ ...input, provider: 'feishu' });
  }
}
