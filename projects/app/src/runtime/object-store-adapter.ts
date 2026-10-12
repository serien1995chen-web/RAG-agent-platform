/**
 * 运行时 ObjectStore 适配：把 service 层 `ObjectStorePort`（RequestContext）
 * 转换为底层 `@kb/storage` 的 `ObjectStorePort`（TenantObjectContext）。
 * 禁止把 RequestContext 直接透传给 `runtime.clients.objectStore`。
 */
import type { ObjectStorePort, RequestContext } from '@kb/service';
import type {
  ObjectRef as StorageObjectRef,
  ObjectStorePort as StorageObjectStorePort,
  TenantObjectContext,
} from '@kb/storage';

/**
 * key 前缀 `dataset/{datasetId}` 时补 datasetId；`temp/{teamId}`、`image/{teamId}` 只带 teamId。
 * 与底层 `assertObjectKeyScope` 的语义保持一致。
 */
export function tenantContextOf(
  context: RequestContext,
  ref: StorageObjectRef,
): TenantObjectContext {
  const [prefix, scopeId] = ref.key.split('/');
  if (prefix === 'dataset' && scopeId) {
    return { teamId: context.tenant.teamId, datasetId: scopeId };
  }
  return { teamId: context.tenant.teamId };
}

export function createRuntimeObjectStorePort(store: StorageObjectStorePort): ObjectStorePort {
  return {
    put: (input, context) =>
      store.put({ ref: input.ref, body: input.body }, tenantContextOf(context, input.ref)),
    get: (input, context) => store.get({ ref: input.ref }, tenantContextOf(context, input.ref)),
    delete: (input, context) =>
      store.delete({ ref: input.ref }, tenantContextOf(context, input.ref)),
    promote: (input, context) =>
      store.promote({ ref: input.ref }, tenantContextOf(context, input.ref)),
    prepareMultipart: (input, context) =>
      store.prepareMultipart(
        { ref: input.ref, parts: input.parts },
        tenantContextOf(context, input.ref),
      ),
    uploadPart: (input, context) =>
      store.uploadPart(
        {
          ref: input.ref,
          uploadId: input.uploadId,
          partNumber: input.partNumber,
          body: input.body,
          checksum: input.checksum,
        },
        tenantContextOf(context, input.ref),
      ),
    completeMultipart: (input, context) =>
      store.completeMultipart(
        { ref: input.ref, uploadId: input.uploadId, parts: input.parts, hash: input.hash },
        tenantContextOf(context, input.ref),
      ),
    abort: (input, context) => store.abort({ ref: input.ref }, tenantContextOf(context, input.ref)),
  };
}
