/**
 * ObjectStorePort（设计文档 7.6 / 10.9.1，CR-REF-06）。
 * 对象 key 由系统生成、不对外暴露；所有访问必须校验租户归属。
 */
export interface ObjectRef {
  bucket: string;
  key: string;
  size?: number;
  etag?: string;
  ttlExpireAt?: string | null;
  multipartUploadId?: string;
}

export interface TenantObjectContext {
  teamId: string;
  datasetId?: string;
}

export interface ObjectStorePort {
  ensureBucket(): Promise<void>;
  put(
    input: { ref: ObjectRef; body: Uint8Array },
    context: TenantObjectContext,
  ): Promise<ObjectRef>;
  get(
    input: { ref: ObjectRef },
    context: TenantObjectContext,
  ): Promise<{ ref: ObjectRef; body: Uint8Array }>;
  delete(input: { ref: ObjectRef }, context: TenantObjectContext): Promise<{ deleted: boolean }>;
  promote(input: { ref: ObjectRef }, context: TenantObjectContext): Promise<ObjectRef>;
  prepareMultipart(
    input: { ref: ObjectRef; parts: number },
    context: TenantObjectContext,
  ): Promise<ObjectRef>;
  abort(input: { ref: ObjectRef }, context: TenantObjectContext): Promise<{ aborted: boolean }>;
}
