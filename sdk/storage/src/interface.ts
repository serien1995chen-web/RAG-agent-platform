/**
 * ObjectStorePort（设计文档 7.6 / 10.9.1，CR-REF-06）。
 * 对象 key 由系统生成、不对外暴露；所有访问必须校验租户归属。
 * key 前缀只允许 temp/{teamId}、image/{teamId}、dataset/{datasetId}；
 * 跨团队/跨 Dataset 访问返回 501061；对象不存在返回 501015；
 * 其他存储故障返回 501016，错误参数不得包含完整内部 key。
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

/**
 * 分片上传输入：uploadId 由 prepareMultipart 返回；
 * checksum 由调用方计算，用于分片字节级完整性校验（不匹配返回 501060）。
 */
export interface MultipartPartUpload {
  ref: ObjectRef;
  uploadId: string;
  partNumber: number;
  body: Uint8Array;
  checksum: string;
}

/** 分片上传回执：partNumber + etag 用于 completeMultipart；size 用于总大小校验。 */
export interface MultipartPartReceipt {
  partNumber: number;
  etag: string;
  size: number;
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
  uploadPart(
    input: MultipartPartUpload,
    context: TenantObjectContext,
  ): Promise<MultipartPartReceipt>;
  completeMultipart(
    input: {
      ref: ObjectRef;
      uploadId: string;
      parts: readonly MultipartPartReceipt[];
      hash: string;
    },
    context: TenantObjectContext,
  ): Promise<ObjectRef>;
  abort(input: { ref: ObjectRef }, context: TenantObjectContext): Promise<{ aborted: boolean }>;
}
