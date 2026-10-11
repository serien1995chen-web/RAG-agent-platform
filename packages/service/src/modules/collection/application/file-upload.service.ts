import { createHash } from 'node:crypto';
import { ApiErrorException, createApiError } from '@kb/contracts';

export interface MultipartSessionValue {
  fileId: string;
  teamId: string;
  datasetId: string;
  key: string;
  uploadId: string;
  bucket: string;
  expectedSize?: number;
}

export interface MultipartPartValue {
  partNumber: number;
  etag: string;
  size: number;
  checksum?: string;
}

/**
 * P4-07 multipart session 与分片记录（Rev2 内部应用服务，不落 Mongo 新 Schema）。
 * 由 presignUpload 真实创建 session；uploadPart 记录分片；complete 校验后清理；abort 清理。
 */
export class FileUploadService {
  private readonly sessions = new Map<string, MultipartSessionValue>();
  private readonly uploadIndex = new Map<string, string>();
  private readonly parts = new Map<string, Map<number, MultipartPartValue>>();

  createSession(session: MultipartSessionValue): void {
    this.sessions.set(session.fileId, session);
    if (session.uploadId) this.uploadIndex.set(session.uploadId, session.fileId);
    this.parts.set(session.fileId, new Map());
  }

  getSession(fileId: string, teamId: string): MultipartSessionValue | null {
    const session = this.sessions.get(fileId);
    if (!session || session.teamId !== teamId) return null;
    return session;
  }

  getSessionByUploadId(uploadId: string, teamId: string): MultipartSessionValue | null {
    const fileId = this.uploadIndex.get(uploadId);
    if (!fileId) return null;
    return this.getSession(fileId, teamId);
  }

  findPartByChecksum(fileId: string, partNumber: number, checksum: string): string | null {
    const part = this.parts.get(fileId)?.get(partNumber);
    if (part && part.checksum === checksum) return part.etag;
    return null;
  }

  recordPart(
    fileId: string,
    part: Omit<MultipartPartValue, 'partNumber'> & { partNumber: number },
  ): void {
    const bucket = this.parts.get(fileId) ?? new Map<number, MultipartPartValue>();
    bucket.set(part.partNumber, {
      partNumber: part.partNumber,
      etag: part.etag,
      size: part.size,
      ...(part.checksum !== undefined ? { checksum: part.checksum } : {}),
    });
    this.parts.set(fileId, bucket);
  }

  listParts(fileId: string): MultipartPartValue[] {
    const bucket = this.parts.get(fileId);
    if (!bucket) return [];
    return [...bucket.values()].sort((a, b) => a.partNumber - b.partNumber);
  }

  totalSize(fileId: string): number {
    return this.listParts(fileId).reduce((sum, part) => sum + part.size, 0);
  }

  /** complete 前置校验：分片存在、顺序连续、ETag 匹配、累计大小>0；不符返回稳定 501060。 */
  validateComplete(
    fileId: string,
    teamId: string,
    parts: Array<{ partNumber: number; etag: string }>,
    hash: string,
    requestId: string,
  ): MultipartSessionValue {
    const session = this.getSession(fileId, teamId);
    if (!session) {
      throw new ApiErrorException(createApiError({ code: 501061, requestId, params: { fileId } }));
    }
    const recorded = this.listParts(fileId);
    if (recorded.length === 0 || this.totalSize(fileId) <= 0) {
      throw new ApiErrorException(
        createApiError({ code: 501060, requestId, params: { reason: 'no_parts' } }),
      );
    }
    // 请求必须覆盖全部已记录分片（不接受少报），数量一致。
    if (parts.length !== recorded.length) {
      throw new ApiErrorException(
        createApiError({
          code: 501060,
          requestId,
          params: { reason: 'incomplete_parts', expected: recorded.length, actual: parts.length },
        }),
      );
    }
    const expected = new Map(recorded.map((part) => [part.partNumber, part.etag]));
    // 顺序必须升序且与记录一致（无缺号、无重复、无乱序）。
    const actualNumbers = parts.map((part) => part.partNumber);
    const recordedNumbers = recorded.map((part) => part.partNumber);
    for (let i = 0; i < actualNumbers.length; i += 1) {
      if (actualNumbers[i] !== recordedNumbers[i]) {
        throw new ApiErrorException(
          createApiError({
            code: 501060,
            requestId,
            params: { reason: 'part_order_mismatch', at: i },
          }),
        );
      }
    }
    // 每片 ETag 必须匹配。
    for (const part of parts) {
      if (expected.get(part.partNumber) !== part.etag) {
        throw new ApiErrorException(
          createApiError({
            code: 501060,
            requestId,
            params: { partNumber: part.partNumber, reason: 'etag_mismatch' },
          }),
        );
      }
    }
    // 每片必须记录 checksum（complete 前校验）。
    if (recorded.some((part) => !part.checksum)) {
      throw new ApiErrorException(
        createApiError({ code: 501060, requestId, params: { reason: 'missing_checksum' } }),
      );
    }
    // 期望总大小：session 记录的值必须与实际累计一致。
    const actualSize = this.totalSize(fileId);
    if (session.expectedSize !== undefined && actualSize !== session.expectedSize) {
      throw new ApiErrorException(
        createApiError({
          code: 501060,
          requestId,
          params: { reason: 'size_mismatch', expected: session.expectedSize, actual: actualSize },
        }),
      );
    }
    // 真实 hash 校验：以服务端记录的分片序号/ETag/checksum 计算期望 hash 再比对。
    const expectedHash = createHash('sha256')
      .update(
        recorded.map((part) => `${part.partNumber}:${part.etag}:${part.checksum ?? ''}`).join('\n'),
      )
      .digest('hex');
    if (hash !== expectedHash) {
      throw new ApiErrorException(
        createApiError({ code: 501060, requestId, params: { reason: 'hash_mismatch' } }),
      );
    }
    return session;
  }

  deleteSession(fileId: string): void {
    const session = this.sessions.get(fileId);
    if (session?.uploadId) this.uploadIndex.delete(session.uploadId);
    this.sessions.delete(fileId);
    this.parts.delete(fileId);
  }

  reset(): void {
    this.sessions.clear();
    this.uploadIndex.clear();
    this.parts.clear();
  }
}
