import { ApiErrorException, createApiError } from '@kb/contracts';
import type { ObjectRef, TenantObjectContext } from './interface';

export const OBJECT_KEY_PREFIXES = ['temp', 'image', 'dataset'] as const;

export function objectKeyHash(key: string): string {
  let hash = 0;
  for (const char of key) {
    hash = (hash * 31 + char.codePointAt(0)!) % 2147483647;
  }
  return `k${hash.toString(36)}`;
}

/**
 * key 前缀必须为 temp/{teamId}、image/{teamId} 或 dataset/{datasetId}。
 * 跨团队或不合法 key 返回稳定错误 501061，禁止继续访问对象。
 */
export function assertObjectKeyScope(ref: ObjectRef, context: TenantObjectContext): void {
  const reject = (reason: string) => {
    throw new ApiErrorException(
      createApiError({
        code: 501061,
        requestId: 'object-store-scope',
        params: { fileId: objectKeyHash(ref.key), datasetId: context.datasetId ?? '' },
        message: reason,
      }),
    );
  };

  if (ref.key.startsWith('/') || ref.key.includes('..') || ref.key.includes('\\')) {
    reject('对象 key 非法');
  }
  const [prefix, scopeId] = ref.key.split('/');
  if (prefix === 'temp' || prefix === 'image') {
    if (scopeId !== context.teamId) reject('对象不属于当前团队');
    return;
  }
  if (prefix === 'dataset') {
    if (!context.datasetId || scopeId !== context.datasetId) reject('对象不属于当前 Dataset');
    return;
  }
  reject('对象 key 前缀未登记');
}
