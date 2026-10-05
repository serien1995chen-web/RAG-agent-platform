import { createAgentExtension } from './agent/agent.extension';
import { createApplicationExtension } from './application/application.extension';
import { createIdentityExtension } from './identity/dev-identity.provider';
import { createPublishExtension } from './publish/publish.extension';
import { ExtensionRegistry } from './registry';

export { ExtensionRegistry } from './registry';
export type { ExtensionDescriptor, ExtensionId } from './registry';
export type { AgentExtensionContract } from './agent/agent.extension';
export type { ApplicationExtensionContract } from './application/application.extension';
export type { PublishExtensionContract } from './publish/publish.extension';

/** 默认注册四个扩展点：Dataset 核心不依赖任何扩展启用。 */
export function createDefaultExtensionRegistry(options: {
  environment: 'development' | 'test' | 'production';
  devIdentity: { teamId: string; tmbId: string } | null;
}): ExtensionRegistry {
  const registry = new ExtensionRegistry();
  registry.register(createIdentityExtension(options));
  registry.register(createAgentExtension());
  registry.register(createApplicationExtension());
  registry.register(createPublishExtension());
  return registry;
}
