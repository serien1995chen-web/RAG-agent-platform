'use client';

import { knowledgeBinaryRequest, knowledgeRequest } from './knowledge-client';

const PART_SIZE = 8 * 1024 * 1024;

export interface UploadSession {
  uploadId: string;
  mode: 'single' | 'multipart';
  status: 'pending' | 'uploading' | 'completing' | 'completed' | 'aborted' | 'expired';
  partSizeBytes: number;
  partCount: number;
  expiresAt: string;
  version: number;
}

export interface PresignedPart {
  partNumber: number;
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
}

export interface UploadPartResult {
  uploadId: string;
  partNumber: number;
  etag: string;
}

export interface ObjectBlobReference {
  blobId: string;
  workspaceId: string;
  bucket: string;
  objectKey: string;
  state: 'pending' | 'active' | 'deleting' | 'deleted';
  sizeBytes: number;
  etag: string;
}

export interface KnowledgeFileUploadState {
  phase:
    | 'idle'
    | 'initializing'
    | 'uploading'
    | 'completing'
    | 'completed'
    | 'aborted'
    | 'expired'
    | 'error';
  uploadId: string | null;
  progress: number;
  completedParts: number;
  totalParts: number;
  result: ObjectBlobReference | null;
  error: unknown;
}

export interface UploadOptions {
  knowledgeSpaceId: string;
  signal?: AbortSignal;
  onState?: (state: KnowledgeFileUploadState) => void;
}

const STORAGE_PREFIX = 'kb-upload:';

function storageKey(workspaceId: string, fileName: string, size: number): string {
  return `${STORAGE_PREFIX}${workspaceId}:${fileName}:${size}`;
}

function requestKey(): string {
  return globalThis.crypto.randomUUID();
}

function state(
  phase: KnowledgeFileUploadState['phase'],
  uploadId: string | null,
  progress: number,
  completedParts: number,
  totalParts: number,
  result: ObjectBlobReference | null = null,
  error: unknown = null,
): KnowledgeFileUploadState {
  return { phase, uploadId, progress, completedParts, totalParts, result, error };
}

async function directPut(upload: PresignedPart, body: Blob): Promise<string> {
  const response = await fetch(upload.url, {
    method: upload.method,
    headers: upload.headers,
    body,
  });
  if (!response.ok) {
    throw new DOMException(`presigned PUT failed: ${response.status}`, 'NetworkError');
  }
  return response.headers.get('etag')?.replaceAll('"', '') ?? `part-${upload.partNumber}`;
}

export async function knowledgeBinaryUpload(
  path: string,
  body: Blob | ArrayBuffer | Uint8Array,
  idempotencyKey: string,
): Promise<UploadPartResult> {
  return knowledgeBinaryRequest<UploadPartResult>(path, body, {
    method: 'PUT',
    idempotencyKey,
  });
}

export async function knowledgeMultipartUpload(
  file: File,
  options: UploadOptions,
): Promise<ObjectBlobReference> {
  const key = requestKey();
  const publish = (next: KnowledgeFileUploadState) => {
    options.onState?.(next);
    if (next.uploadId) {
      globalThis.localStorage?.setItem(
        storageKey(options.knowledgeSpaceId, file.name, file.size),
        JSON.stringify({
          uploadId: next.uploadId,
          phase: next.phase,
          progress: next.progress,
          updatedAt: new Date().toISOString(),
        }),
      );
    }
  };
  publish(state('initializing', null, 0, 0, Math.ceil(file.size / PART_SIZE)));
  const session = await knowledgeRequest<UploadSession>('/v1/knowledge/uploads', {
    method: 'POST',
    idempotencyKey: key,
    body: {
      knowledgeSpaceId: options.knowledgeSpaceId,
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
    },
  });
  if (options.signal?.aborted) {
    await knowledgeRequest(`/v1/knowledge/uploads/${session.uploadId}/abort`, {
      method: 'POST',
      idempotencyKey: key,
      body: { version: session.version },
    });
    throw new DOMException('Upload aborted', 'AbortError');
  }

  try {
    const partNumbers =
      session.mode === 'single'
        ? [1]
        : Array.from({ length: session.partCount }, (_, index) => index + 1);
    const parts: Array<{ partNumber: number; etag: string }> = [];
    for (const partNumber of partNumbers) {
      if (options.signal?.aborted) throw new DOMException('Upload aborted', 'AbortError');
      const start = (partNumber - 1) * PART_SIZE;
      const blob = file.slice(start, Math.min(start + PART_SIZE, file.size));
      let etag: string;
      try {
        const presigned = await knowledgeRequest<{ uploads: PresignedPart[] }>(
          `/v1/knowledge/uploads/${session.uploadId}/presign`,
          {
            method: 'POST',
            idempotencyKey: key,
            body: { partNumbers: [partNumber] },
          },
        );
        etag = await directPut(presigned.uploads[0]!, blob);
      } catch {
        const result = await knowledgeBinaryUpload(
          `/v1/knowledge/uploads/${session.uploadId}/parts/${partNumber}`,
          blob,
          key,
        );
        etag = result.etag;
      }
      parts.push({ partNumber, etag });
      const progress = Math.round((partNumber / partNumbers.length) * 100);
      publish(state('uploading', session.uploadId, progress, partNumber, partNumbers.length));
    }
    publish(state('completing', session.uploadId, 100, parts.length, parts.length));
    const result = await knowledgeRequest<ObjectBlobReference>(
      `/v1/knowledge/uploads/${session.uploadId}/complete`,
      {
        method: 'POST',
        idempotencyKey: key,
        body: { parts },
      },
    );
    publish(state('completed', session.uploadId, 100, parts.length, parts.length, result));
    return result;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      await knowledgeRequest(`/v1/knowledge/uploads/${session.uploadId}/abort`, {
        method: 'POST',
        idempotencyKey: key,
        body: { version: session.version },
      }).catch(() => undefined);
      publish(state('aborted', session.uploadId, 0, 0, session.partCount, null, error));
    } else {
      publish(state('error', session.uploadId, 0, 0, session.partCount, null, error));
    }
    throw error;
  }
}

export async function restoreKnowledgeUpload(
  workspaceId: string,
  fileName: string,
  size: number,
): Promise<UploadSession | null> {
  const stored = globalThis.localStorage?.getItem(storageKey(workspaceId, fileName, size));
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored) as { uploadId?: string; phase?: string };
    if (!parsed.uploadId || parsed.phase === 'completed' || parsed.phase === 'aborted') {
      return null;
    }
    return knowledgeRequest<UploadSession>(`/v1/knowledge/uploads/${parsed.uploadId}`);
  } catch {
    return null;
  }
}

export function clearKnowledgeUpload(workspaceId: string, fileName: string, size: number): void {
  globalThis.localStorage?.removeItem(storageKey(workspaceId, fileName, size));
}
