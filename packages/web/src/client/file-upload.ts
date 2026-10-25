'use client';

import { ensureConsoleSession, knowledgeBinaryRequest, knowledgeRequest } from './knowledge-client';

const PART_SIZE = 8 * 1024 * 1024;
const FINGERPRINT_PREFIX_BYTES = 64 * 1024;

export interface UploadSession {
  uploadId: string;
  mode: 'single' | 'multipart';
  status: 'pending' | 'uploading' | 'completing' | 'completed' | 'aborted' | 'expired';
  partSizeBytes: number;
  partCount: number;
  originalName: string;
  expiresAt: string;
  version: number;
  parts: UploadedPart[];
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

export interface UploadedPart {
  partNumber: number;
  etag: string;
  sizeBytes?: number;
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

function storageIdentity(workspaceId: string, fileName: string, size: number): string {
  return `${STORAGE_PREFIX}${workspaceId}:${fileName}:${size}:`;
}

function storageKey(
  workspaceId: string,
  fileName: string,
  size: number,
  fingerprint: string,
): string {
  return `${storageIdentity(workspaceId, fileName, size)}${fingerprint}`;
}

function requestKey(): string {
  return globalThis.crypto.randomUUID();
}

function partKey(baseKey: string, partNumber: number): string {
  return `${baseKey}:p:${partNumber}`;
}

export async function fileFingerprint(file: File): Promise<string | null> {
  try {
    const digest = await globalThis.crypto.subtle.digest(
      'SHA-256',
      await file.slice(0, Math.min(file.size, FINGERPRINT_PREFIX_BYTES)).arrayBuffer(),
    );
    const prefixHash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    return `${file.lastModified}:${file.size}:${prefixHash}`;
  } catch {
    return null;
  }
}

function normalizeSession(session: UploadSession): UploadSession {
  return {
    ...session,
    parts: Array.isArray(session.parts) ? session.parts : [],
  };
}

async function abortLatestSession(session: UploadSession, idempotencyBase: string): Promise<void> {
  let latest = session;
  try {
    latest = normalizeSession(
      await knowledgeRequest<UploadSession>(`/v1/knowledge/uploads/${session.uploadId}`),
    );
  } catch {
    // Fall back to the last locally observed version; server cleanup remains authoritative.
  }
  await knowledgeRequest(`/v1/knowledge/uploads/${session.uploadId}/abort`, {
    method: 'POST',
    idempotencyKey: `${idempotencyBase}:abort:${latest.version}`,
    body: { version: latest.version },
  });
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
  const etag = response.headers.get('etag')?.replaceAll('"', '');
  if (!etag) {
    throw new DOMException('presigned PUT missing etag', 'NetworkError');
  }
  return etag;
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
  const workspaceId = (await ensureConsoleSession()).workspaceId;
  const fingerprint = await fileFingerprint(file);
  const key = requestKey();
  let completedParts: UploadedPart[] = [];
  let session: UploadSession | undefined;
  const publish = (next: KnowledgeFileUploadState) => {
    options.onState?.(next);
    if (next.uploadId && fingerprint) {
      globalThis.localStorage?.setItem(
        storageKey(workspaceId, file.name, file.size, fingerprint),
        JSON.stringify({
          uploadId: next.uploadId,
          phase: next.phase,
          progress: next.progress,
          parts: completedParts,
          fingerprint,
          updatedAt: new Date().toISOString(),
        }),
      );
    }
  };
  publish(state('initializing', null, 0, 0, Math.ceil(file.size / PART_SIZE)));
  const restored = fingerprint
    ? await restoreUploadWithFingerprint(workspaceId, file, fingerprint)
    : null;
  const resumable =
    restored &&
    ['pending', 'uploading'].includes(restored.status) &&
    Date.parse(restored.expiresAt) > Date.now();
  if (resumable) {
    session = normalizeSession(restored);
    completedParts = [...session.parts];
  } else {
    session = normalizeSession(
      await knowledgeRequest<UploadSession>('/v1/knowledge/uploads', {
        method: 'POST',
        idempotencyKey: key,
        body: {
          knowledgeSpaceId: options.knowledgeSpaceId,
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          sizeBytes: file.size,
        },
      }),
    );
  }
  if (options.signal?.aborted) {
    await abortLatestSession(session, key).catch(() => undefined);
    clearKnowledgeUpload(workspaceId, file.name, file.size, fingerprint ?? undefined);
    throw new DOMException('Upload aborted', 'AbortError');
  }

  try {
    const partNumbers =
      session.mode === 'single'
        ? [1]
        : Array.from({ length: session.partCount }, (_, index) => index + 1);
    const uploaded = new Set(completedParts.map((part) => part.partNumber));
    for (const partNumber of partNumbers) {
      if (uploaded.has(partNumber)) continue;
      if (options.signal?.aborted) throw new DOMException('Upload aborted', 'AbortError');
      const start = (partNumber - 1) * PART_SIZE;
      const blob = file.slice(start, Math.min(start + PART_SIZE, file.size));
      const keyForPart = partKey(key, partNumber);
      let etag: string;
      try {
        const presigned = await knowledgeRequest<{ uploads: PresignedPart[] }>(
          `/v1/knowledge/uploads/${session.uploadId}/presign`,
          {
            method: 'POST',
            idempotencyKey: keyForPart,
            body: { partNumbers: [partNumber] },
          },
        );
        etag = await directPut(presigned.uploads[0]!, blob);
      } catch {
        const result = await knowledgeBinaryUpload(
          `/v1/knowledge/uploads/${session.uploadId}/parts/${partNumber}`,
          blob,
          keyForPart,
        );
        etag = result.etag;
      }
      completedParts = [
        ...completedParts.filter((part) => part.partNumber !== partNumber),
        { partNumber, etag },
      ].sort((left, right) => left.partNumber - right.partNumber);
      const progress = Math.round((completedParts.length / partNumbers.length) * 100);
      publish(
        state('uploading', session.uploadId, progress, completedParts.length, partNumbers.length),
      );
    }
    publish(state('completing', session.uploadId, 100, completedParts.length, partNumbers.length));
    const result = await knowledgeRequest<ObjectBlobReference>(
      `/v1/knowledge/uploads/${session.uploadId}/complete`,
      {
        method: 'POST',
        idempotencyKey: `${key}:complete`,
        body: { parts: completedParts },
      },
    );
    publish(
      state('completed', session.uploadId, 100, completedParts.length, partNumbers.length, result),
    );
    clearKnowledgeUpload(workspaceId, file.name, file.size, fingerprint ?? undefined);
    return result;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      await abortLatestSession(session, key).catch(() => undefined);
      clearKnowledgeUpload(workspaceId, file.name, file.size, fingerprint ?? undefined);
      publish(
        state(
          'aborted',
          session.uploadId,
          0,
          completedParts.length,
          session.partCount,
          null,
          error,
        ),
      );
    } else {
      publish(
        state('error', session.uploadId, 0, completedParts.length, session.partCount, null, error),
      );
    }
    throw error;
  }
}

export async function restoreKnowledgeUpload(
  workspaceId: string,
  file: File,
): Promise<UploadSession | null> {
  const fingerprint = await fileFingerprint(file);
  return fingerprint ? restoreUploadWithFingerprint(workspaceId, file, fingerprint) : null;
}

async function restoreUploadWithFingerprint(
  workspaceId: string,
  file: File,
  fingerprint: string,
): Promise<UploadSession | null> {
  const key = storageKey(workspaceId, file.name, file.size, fingerprint);
  const stored = globalThis.localStorage?.getItem(key);
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored) as {
      uploadId?: string;
      phase?: string;
      parts?: UploadedPart[];
      fingerprint?: string;
    };
    if (
      parsed.fingerprint !== fingerprint ||
      !parsed.uploadId ||
      parsed.phase === 'completed' ||
      parsed.phase === 'aborted'
    ) {
      globalThis.localStorage?.removeItem(key);
      return null;
    }
    const session = normalizeSession(
      await knowledgeRequest<UploadSession>(`/v1/knowledge/uploads/${parsed.uploadId}`),
    );
    if (
      !['pending', 'uploading'].includes(session.status) ||
      Date.parse(session.expiresAt) <= Date.now()
    ) {
      globalThis.localStorage?.removeItem(key);
      return null;
    }
    const byPart = new Map<number, UploadedPart>();
    for (const part of [...session.parts, ...(parsed.parts ?? [])]) {
      if (
        Number.isInteger(part.partNumber) &&
        part.partNumber > 0 &&
        typeof part.etag === 'string' &&
        part.etag.length > 0
      ) {
        byPart.set(part.partNumber, part);
      }
    }
    return {
      ...session,
      parts: [...byPart.values()].sort((left, right) => left.partNumber - right.partNumber),
    };
  } catch {
    return null;
  }
}

export function clearKnowledgeUpload(
  workspaceId: string,
  fileName: string,
  size: number,
  fingerprint?: string,
): void {
  const storage = globalThis.localStorage;
  if (!storage) return;
  if (fingerprint) {
    storage.removeItem(storageKey(workspaceId, fileName, size, fingerprint));
    return;
  }
  const prefix = storageIdentity(workspaceId, fileName, size);
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (key?.startsWith(prefix)) storage.removeItem(key);
  }
}
