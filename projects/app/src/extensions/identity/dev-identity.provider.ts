import type { AuthSubjectProvider } from '@kb/service';
import type { ExtensionDescriptor } from '../registry';

/**
 * identity 扩展点（设计文档 9.2）：仅开发/测试环境提供固定主体；
 * 生产实现留空，teamId/tmbId 永远不接受请求体声明。
 */
export function createIdentityExtension(options: {
  environment: 'development' | 'test' | 'production';
  devIdentity: { teamId: string; tmbId: string } | null;
}): ExtensionDescriptor<AuthSubjectProvider> {
  const enabled = options.environment !== 'production' && options.devIdentity !== null;
  return {
    id: 'identity',
    version: '1.0.0',
    capabilities: ['auth.subject.resolve'],
    enabled,
    implementation: enabled
      ? {
          resolve: async () => ({
            teamId: options.devIdentity!.teamId,
            tmbId: options.devIdentity!.tmbId,
            authType: 'token',
            isRoot: false,
            sourceName: 'dev-identity',
          }),
        }
      : null,
  };
}
