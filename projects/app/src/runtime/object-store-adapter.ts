/**
 * 运行时 ObjectStore 适配：把 service 层 `ObjectStorePort`（RequestContext）
 * 转换为底层 `@kb/storage` 的 `ObjectStorePort`（TenantObjectContext）。
 * 禁止把 RequestContext 直接透传给 `runtime.clients.objectStore`。
 */
import { ApiErrorException, createApiError } from '@kb/contracts';
import type { ObjectStorePort, RequestContext } from '@kb/service';
import { objectKeyHash } from '@kb/storage';
import type {
  ObjectRef as StorageObjectRef,
  ObjectStorePort as StorageObjectStorePort,
  TenantObjectContext,
} from '@kb/storage';

function scopeForbidden(
  context: RequestContext,
  key: string,
  authorizedDatasetId?: string,
): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code: 501061,
      requestId: context.requestId,
      params: { fileId: objectKeyHash(key), datasetId: authorizedDatasetId ?? '' },
    }),
  );
}

/**
 * 只用调用方**已授权**的 datasetId 构造 TenantObjectContext，绝不从 key 反推。
 * `dataset/{scopeId}/...` 必须 `scopeId === authorizedDatasetId`，否则在触网前返回 501061；
 * `temp/{teamId}`、`image/{teamId}` 仍只使用 teamId。
 */
export function tenantContextOf(
  context: RequestContext,
  ref: StorageObjectRef,
  authorizedDatasetId?: string,
): TenantObjectContext {
  const [prefix, scopeId] = ref.key.split('/');
  if (prefix === 'dataset') {
    if (!authorizedDatasetId || scopeId !== authorizedDatasetId) {
      throw scopeForbidden(context, ref.key, authorizedDatasetId);
    }
    return { teamId: context.tenant.teamId, datasetId: authorizedDatasetId };
  }
  return { teamId: context.tenant.teamId };
}

export function createRuntimeObjectStorePort(store: StorageObjectStorePort): ObjectStorePort {
  return {
    async put(input, context) {
      return store.put(
        { ref: input.ref, body: input.body },
        tenantContextOf(context, input.ref, input.datasetId),
      );
    },
    async get(input, context) {
      return store.get({ ref: input.ref }, tenantContextOf(context, input.ref, input.datasetId));
    },
    async delete(input, context) {
      return store.delete({ ref: input.ref }, tenantContextOf(context, input.ref, input.datasetId));
    },
    async promote(input, context) {
      return store.promote(
        { ref: input.ref },
        tenantContextOf(context, input.ref, input.datasetId),
      );
    },
    async prepareMultipart(input, context) {
      return store.prepareMultipart(
        { ref: input.ref, parts: input.parts },
        tenantContextOf(context, input.ref, input.datasetId),
      );
    },
    async uploadPart(input, context) {
      return store.uploadPart(
        {
          ref: input.ref,
          uploadId: input.uploadId,
          partNumber: input.partNumber,
          body: input.body,
          checksum: input.checksum,
        },
        tenantContextOf(context, input.ref, input.datasetId),
      );
    },
    async completeMultipart(input, context) {
      return store.completeMultipart(
        { ref: input.ref, uploadId: input.uploadId, parts: input.parts, hash: input.hash },
        tenantContextOf(context, input.ref, input.datasetId),
      );
    },
    async abort(input, context) {
      return store.abort({ ref: input.ref }, tenantContextOf(context, input.ref, input.datasetId));
    },
  };
}
