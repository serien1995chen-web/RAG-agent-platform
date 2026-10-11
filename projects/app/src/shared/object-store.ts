export interface TenantContext {
  tenant: { teamId: string; tmbId: string; authType: string; isRoot: boolean };
}

export interface ObjectStoreRuntimePort {
  get(
    input: { ref: { bucket: string; key: string } },
    context: TenantContext,
  ): Promise<{ body: Uint8Array }>;
  presignPut(
    input: { ref: { bucket: string; key: string }; expiresSeconds: number },
    context: TenantContext,
  ): Promise<string>;
  presignGet(
    input: { ref: { bucket: string; key: string }; expiresSeconds: number },
    context: TenantContext,
  ): Promise<string>;
  prepareMultipart(
    input: {
      ref: { bucket: string; key: string };
      parts: number;
    },
    context: TenantContext,
  ): Promise<{ multipartUploadId?: string }>;
  uploadPart(
    input: {
      ref: { bucket: string; key: string; multipartUploadId?: string };
      partNumber: number;
      body: Uint8Array;
      checksum?: string;
    },
    context: TenantContext,
  ): Promise<{ etag: string; partNumber: number; size: number }>;
  completeMultipart(
    input: {
      ref: { bucket: string; key: string; multipartUploadId?: string };
      parts: Array<{ partNumber: number; etag: string }>;
    },
    context: TenantContext,
  ): Promise<{ etag?: string }>;
  abort(
    input: { ref: { bucket: string; key: string } },
    context: TenantContext,
  ): Promise<{ aborted: boolean }>;
}

export function objectStoreOf(runtime: unknown): ObjectStoreRuntimePort | null {
  const store = (runtime as { clients?: { objectStore?: unknown } }).clients?.objectStore as
    | (ObjectStoreRuntimePort & { presignGet?: ObjectStoreRuntimePort['presignGet'] })
    | undefined;
  if (!store || typeof store.presignPut !== 'function') return null;
  return store;
}
