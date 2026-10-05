import { ApiErrorException, createApiError } from '@kb/contracts';

/** 设计文档 9.1-9.2：四个非 Dataset 扩展点，首期只登记、不实现业务。 */
export type ExtensionId = 'identity' | 'agent' | 'application' | 'publish';

export interface ExtensionDescriptor<TContract = unknown> {
  id: ExtensionId;
  version: string;
  capabilities: readonly string[];
  enabled: boolean;
  implementation: TContract | null;
}

/**
 * 扩展注册表：注册、查询、能力探测与关闭开关。
 * 未启用时必须返回稳定错误 501020，不得回退到猜测实现。
 */
export class ExtensionRegistry {
  private readonly extensions = new Map<ExtensionId, ExtensionDescriptor>();

  register<TContract>(descriptor: ExtensionDescriptor<TContract>): void {
    this.extensions.set(descriptor.id, descriptor as ExtensionDescriptor);
  }

  isEnabled(id: ExtensionId): boolean {
    return this.extensions.get(id)?.enabled ?? false;
  }

  get<TContract>(id: ExtensionId): TContract | null {
    const descriptor = this.extensions.get(id);
    if (!descriptor?.enabled || !descriptor.implementation) return null;
    return descriptor.implementation as TContract;
  }

  require<TContract>(id: ExtensionId, requestId = 'extension'): TContract {
    const implementation = this.get<TContract>(id);
    if (!implementation) {
      throw new ApiErrorException(
        createApiError({ code: 501020, requestId, params: { extension: id } }),
      );
    }
    return implementation;
  }

  describe(): ExtensionDescriptor[] {
    return [...this.extensions.values()];
  }
}
