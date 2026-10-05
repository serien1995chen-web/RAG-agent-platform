import { ConfigValidationException } from './config-error';
import { readString, type EnvSource } from './env';

/**
 * 密钥只保存引用（设计文档 6.6 / 18.5）。
 * 本地开发支持 `env:NAME` 引用；生产环境由外部密钥管理系统注入（后续阶段实现）。
 */
export function resolveSecretRef(ref: string, env: EnvSource = process.env): string {
  if (ref.startsWith('env:')) {
    const name = ref.slice('env:'.length);
    const value = readString(env, name);
    if (!value) {
      throw new ConfigValidationException([`secretRef ${ref}: 环境变量 ${name} 未配置`]);
    }
    return value;
  }
  throw new ConfigValidationException([`secretRef ${ref}: 不支持的引用协议`]);
}
