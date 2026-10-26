import type { TenantContext } from '../../../../shared/persistence/knowledge/tenant';
import type {
  CloudConnectorProvider,
  CloudProviderClientPort,
  ProviderCatalogResult,
  ProviderContent,
} from '../../application/ingestion.ports';

const FIXTURE_ITEMS: Readonly<
  Record<
    CloudConnectorProvider,
    Array<{ id: string; name: string; type: 'directory' | 'document' }>
  >
> = {
  feishu: [
    { id: 'fld_support', name: 'Support', type: 'directory' },
    { id: 'doc_runbook', name: 'Runbook', type: 'document' },
  ],
  yuque: [
    { id: 'repo_eng/toc_1', name: 'Engineering', type: 'directory' },
    { id: 'repo_eng/toc_1/doc_1', name: 'Architecture', type: 'document' },
  ],
  dingtalk: [
    { id: 'wiki_root/node_1', name: 'Knowledge Wiki', type: 'directory' },
    { id: 'wiki_root/node_1/doc_1', name: 'Operations', type: 'document' },
  ],
};

export class MockCloudConnectorClient implements CloudProviderClientPort {
  readonly verificationStatus = 'EXTERNAL_UNVERIFIED' as const;

  async catalog(input: {
    provider: CloudConnectorProvider;
    config: Record<string, unknown>;
    credentials: Record<string, unknown>;
    rootId: string;
    cursor?: string;
    context: TenantContext;
  }): Promise<ProviderCatalogResult> {
    return {
      provider: input.provider,
      items: FIXTURE_ITEMS[input.provider].map((item) => ({ ...item })),
      nextCursor: null,
    };
  }

  async content(input: {
    provider: CloudConnectorProvider;
    config: Record<string, unknown>;
    credentials: Record<string, unknown>;
    externalIds: readonly string[];
    context: TenantContext;
  }): Promise<ProviderContent[]> {
    const known = new Map(FIXTURE_ITEMS[input.provider].map((item) => [item.id, item]));
    return input.externalIds.map((externalId) => {
      const item = known.get(externalId);
      return {
        externalId,
        title: item?.name ?? externalId,
        mimeType: 'text/markdown',
        bytes: Buffer.from(
          `# ${item?.name ?? externalId}\n\nProvider fixture content for ${input.provider}.`,
          'utf8',
        ),
      };
    });
  }
}
