import type { Client } from 'minio';
import type { ObjectRef, TenantObjectContext } from './interface';
import { assertObjectKeyScope } from './tenant-scope';

/**
 * 显式签名 URL 助手（设计文档 12.6 / 7.6）：
 * 只在调用方按需签发；有效期由调用方显式给出（无默认值）；
 * 执行前先校验租户归属，不打印日志、不返回内部路径之外的调试信息。
 */
export async function presignObjectUrl(
  client: Client,
  ref: ObjectRef,
  context: TenantObjectContext,
  expiresSeconds: number,
): Promise<string> {
  assertObjectKeyScope(ref, context);
  return client.presignedGetObject(ref.bucket, ref.key, expiresSeconds);
}
