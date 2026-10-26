import { createKnowledgeError } from '@kb/contracts';
import type { TenantContext } from '../../../../shared/persistence/knowledge/tenant';
import type {
  CloudConnectorProvider,
  CloudProviderClientPort,
  ProviderCatalogResult,
  ProviderContent,
} from '../../application/ingestion.ports';
import { dependencyStatusError, providerContractError } from '../provider-json';

export type CloudChangeClassification = 'rename' | 'move' | 'delete' | 'non_document' | 'unknown';

interface FixtureItem {
  id: string;
  name: string;
  type: 'directory' | 'document';
}

const FEISHU_PAGE_ONE: FixtureItem[] = [
  { id: 'fld_support', name: 'Support', type: 'directory' },
  { id: 'doc_a', name: 'Runbook', type: 'document' },
];
const FEISHU_PAGE_TWO: FixtureItem[] = [{ id: 'doc_b', name: 'Escalation', type: 'document' }];
const YUQUE_ITEMS: FixtureItem[] = [
  { id: 'repo:eng/toc:1', name: 'Engineering', type: 'directory' },
  { id: 'repo:eng/toc:1/doc:arch', name: 'Architecture', type: 'document' },
];
const DINGTALK_ITEMS: FixtureItem[] = [
  { id: 'wiki:root/node:1', name: 'Knowledge Wiki', type: 'directory' },
  { id: 'wiki:root/node:1/doc:ops', name: 'Operations', type: 'document' },
];

function isYuqueCompositeId(externalId: string): boolean {
  return /^repo:[^/]+(?:\/toc:[^/]+)?\/doc:[^/]+$/.test(externalId);
}

function isDingtalkOnlineDocument(externalId: string): boolean {
  return /^wiki:[^/]+\/node:[^/]+\/doc:[^/]+$/.test(externalId);
}

function unsupported(provider: string, context: TenantContext, reason: string): never {
  throw createKnowledgeError({
    code: 'KNOWLEDGE_UNSUPPORTED_CONTENT',
    requestId: context.requestId,
    traceId: context.traceId,
    details: { provider, reason },
  });
}

function notFound(provider: string, context: TenantContext, externalId: string): never {
  throw createKnowledgeError({
    code: 'KNOWLEDGE_NOT_FOUND',
    requestId: context.requestId,
    traceId: context.traceId,
    details: { provider, externalId, providerStatus: 404 },
  });
}

function rateLimited(provider: string, context: TenantContext): never {
  throw createKnowledgeError({
    code: 'KNOWLEDGE_RATE_LIMITED',
    requestId: context.requestId,
    traceId: context.traceId,
    details: { provider, retryAfterSeconds: 1 },
  });
}

export function classifyCloudProviderChange(
  provider: CloudConnectorProvider,
  input: {
    externalId: string;
    action?: string;
    documentType?: string;
    providerStatus?: number;
    confirmed?: boolean;
    parentChanged?: boolean;
    nameChanged?: boolean;
  },
): CloudChangeClassification {
  if (input.providerStatus === 404) {
    return input.confirmed ? 'delete' : 'unknown';
  }
  if (provider === 'yuque' && !isYuqueCompositeId(input.externalId)) {
    return 'unknown';
  }
  if (provider === 'dingtalk' && input.documentType === 'block') {
    return 'non_document';
  }
  if (input.action === 'delete' || input.action === 'remove') return 'delete';
  if (input.action === 'rename' || input.nameChanged) return 'rename';
  if (input.action === 'move' || input.parentChanged) return 'move';
  return 'unknown';
}

export class MockCloudConnectorClient implements CloudProviderClientPort {
  readonly verificationStatus = 'EXTERNAL_UNVERIFIED' as const;
  tokenRefreshCount = 0;

  private items(
    provider: CloudConnectorProvider,
    cursor: string | undefined,
  ): { items: FixtureItem[]; nextCursor: string | null } {
    if (provider === 'feishu') {
      return cursor === 'page:2'
        ? { items: FEISHU_PAGE_TWO, nextCursor: null }
        : { items: FEISHU_PAGE_ONE, nextCursor: 'page:2' };
    }
    if (provider === 'yuque') {
      return cursor === 'toc:1'
        ? { items: YUQUE_ITEMS.slice(1), nextCursor: null }
        : { items: YUQUE_ITEMS.slice(0, 1), nextCursor: 'toc:1' };
    }
    return cursor === 'node:1'
      ? { items: DINGTALK_ITEMS.slice(1), nextCursor: null }
      : { items: DINGTALK_ITEMS.slice(0, 1), nextCursor: 'node:1' };
  }

  private maybeRefreshToken(
    provider: CloudConnectorProvider,
    credentials: Record<string, unknown>,
    context: TenantContext,
  ): void {
    if (credentials.accessToken === 'invalid') {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
        requestId: 'provider',
        traceId: 'provider',
        details: { provider, providerStatus: 401, errorKind: 'auth' },
      });
    }
    if (credentials.rateLimited === true) {
      rateLimited(provider, context);
    }
    if (credentials.accessToken === 'expired' && this.tokenRefreshCount === 0) {
      this.tokenRefreshCount += 1;
    }
  }

  async catalog(input: {
    provider: CloudConnectorProvider;
    config: Record<string, unknown>;
    credentials: Record<string, unknown>;
    rootId: string;
    cursor?: string;
    context: TenantContext;
  }): Promise<ProviderCatalogResult> {
    this.maybeRefreshToken(input.provider, input.credentials, input.context);
    if (!input.rootId.trim()) {
      return providerContractError(input.provider, input.context, 'root_id_required');
    }
    const page = this.items(input.provider, input.cursor);
    return {
      provider: input.provider,
      items: page.items.map((item) => ({ ...item })),
      nextCursor: page.nextCursor,
    };
  }

  async content(input: {
    provider: CloudConnectorProvider;
    config: Record<string, unknown>;
    credentials: Record<string, unknown>;
    externalIds: readonly string[];
    context: TenantContext;
  }): Promise<ProviderContent[]> {
    this.maybeRefreshToken(input.provider, input.credentials, input.context);
    const providerItems =
      input.provider === 'feishu'
        ? [...FEISHU_PAGE_ONE, ...FEISHU_PAGE_TWO]
        : input.provider === 'yuque'
          ? YUQUE_ITEMS
          : DINGTALK_ITEMS;
    const known = new Map(providerItems.map((item) => [item.id, item]));
    return input.externalIds.map((externalId) => {
      if (externalId.startsWith('missing:')) {
        return notFound(input.provider, input.context, externalId);
      }
      if (input.provider === 'yuque' && !isYuqueCompositeId(externalId)) {
        return unsupported(input.provider, input.context, 'yuque_composite_id_invalid');
      }
      if (
        input.provider === 'dingtalk' &&
        (!isDingtalkOnlineDocument(externalId) || input.config.onlineDocument === false)
      ) {
        return unsupported(input.provider, input.context, 'dingtalk_online_document_required');
      }
      const item = known.get(externalId);
      if (!item) return notFound(input.provider, input.context, externalId);
      if (item.type !== 'document') {
        return unsupported(input.provider, input.context, 'document_required');
      }
      return {
        externalId,
        title: item.name,
        mimeType: 'text/markdown',
        bytes: Buffer.from(
          `# ${item.name}\n\nDeterministic ${input.provider} contract fixture.`,
          'utf8',
        ),
      };
    });
  }
}

export function authFailure(provider: CloudConnectorProvider, context: TenantContext): never {
  return dependencyStatusError(provider, 401, context);
}
