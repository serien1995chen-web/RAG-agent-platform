import { createKnowledgeError } from '@kb/contracts';
import type { TenantContext } from '../../../../shared/persistence/knowledge/tenant';
import type { CloudProviderClientPort } from '../../application/ingestion.ports';
import { FeishuConnectorClient } from './feishu';
import { YuqueConnectorClient } from './yuque';
import { DingtalkConnectorClient } from './dingtalk';
import { FeishuHttpDelegate } from './feishu-http.delegate';
import { YuqueHttpDelegate } from './yuque-http.delegate';
import { DingtalkHttpDelegate } from './dingtalk-http.delegate';

export type ConnectorClientMap = Record<'feishu' | 'yuque' | 'dingtalk', CloudProviderClientPort>;

export class ScopedDeferredConnectorClient implements CloudProviderClientPort {
  constructor(private readonly provider: 'yuque' | 'dingtalk') {}

  async catalog(input: Parameters<CloudProviderClientPort['catalog']>[0]): Promise<never> {
    throw this.denied(input.context);
  }

  async content(input: Parameters<CloudProviderClientPort['content']>[0]): Promise<never> {
    throw this.denied(input.context);
  }

  private denied(context: TenantContext): never {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_UNSUPPORTED_CONTENT',
      requestId: context.requestId,
      traceId: context.traceId,
      details: {
        provider: this.provider,
        scopeProfile: 'knowledge-usability-v1',
        reason: 'DEFERRED_BY_SCOPE',
      },
    });
  }
}

export function createConnectorProviderClients(input: {
  mode: 'mock' | 'real';
  scopeProfile?: 'canonical-v1' | 'knowledge-usability-v1';
}): ConnectorClientMap {
  if (input.mode === 'mock') {
    return {
      feishu: new FeishuConnectorClient(),
      yuque: new YuqueConnectorClient(),
      dingtalk: new DingtalkConnectorClient(),
    };
  }
  const feishu = new FeishuHttpDelegate();
  if (input.scopeProfile === 'knowledge-usability-v1') {
    return {
      feishu,
      yuque: new ScopedDeferredConnectorClient('yuque'),
      dingtalk: new ScopedDeferredConnectorClient('dingtalk'),
    };
  }
  return {
    feishu,
    yuque: new YuqueHttpDelegate(),
    dingtalk: new DingtalkHttpDelegate(),
  };
}
