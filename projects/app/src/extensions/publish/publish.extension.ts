import type { RequestContext } from '@kb/service';
import type { ExtensionDescriptor } from '../registry';

/** 发布渠道不得成为权限事实源，不得绕过 Dataset ACL（设计文档 9.2）。 */
export interface PublishExtensionContract {
  publishChannel(
    input: { datasetId: string; channel: string },
    context: RequestContext,
  ): Promise<{ channelId: string }>;
}

export function createPublishExtension(): ExtensionDescriptor<PublishExtensionContract> {
  return {
    id: 'publish',
    version: '1.0.0',
    capabilities: ['dataset.publish'],
    enabled: false,
    implementation: null,
  };
}
