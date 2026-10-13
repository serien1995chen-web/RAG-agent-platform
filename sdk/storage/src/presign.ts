import { ApiErrorException, createApiError } from '@kb/contracts';
import { Client } from 'minio';
import type { ObjectRef, TenantObjectContext } from './interface';
import { assertObjectKeyScope } from './tenant-scope';

export const PREVIEW_URL_MIN_TTL_SECONDS = 3600;
export const PREVIEW_URL_MAX_TTL_SECONDS = 7200;
export const DEFAULT_PREVIEW_TTL_SECONDS = 3600;

export interface PreviewSignerConfig {
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  region: string;
}

export type PreviewSigner = (
  ref: ObjectRef,
  context: TenantObjectContext,
  expiresSeconds?: number,
) => Promise<string>;

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

export function createPreviewSigner(config: PreviewSignerConfig): PreviewSigner {
  const client = new Client({
    endPoint: config.endPoint,
    port: config.port,
    useSSL: config.useSSL,
    accessKey: config.accessKey,
    secretKey: config.secretKey,
    region: config.region,
  });

  return async (ref, context, expiresSeconds = DEFAULT_PREVIEW_TTL_SECONDS) => {
    if (
      !Number.isInteger(expiresSeconds) ||
      expiresSeconds < PREVIEW_URL_MIN_TTL_SECONDS ||
      expiresSeconds > PREVIEW_URL_MAX_TTL_SECONDS
    ) {
      throw new ApiErrorException(
        createApiError({
          code: 501050,
          requestId: 'preview-signer',
          params: {
            field: 'expiresSeconds',
            value: expiresSeconds,
            rangeOrVersion: '3600-7200',
          },
        }),
      );
    }
    return presignObjectUrl(client, ref, context, expiresSeconds);
  };
}
