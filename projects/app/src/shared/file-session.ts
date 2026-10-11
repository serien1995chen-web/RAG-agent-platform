export interface MultipartSession {
  fileId: string;
  teamId: string;
  datasetId: string;
  key: string;
  uploadId: string;
  bucket: string;
  createdAt: number;
}

export interface MultipartPartRecord {
  etag: string;
  size: number;
}

const sessions = new Map<string, MultipartSession>();
const uploadIndex = new Map<string, string>();
const parts = new Map<string, Map<number, MultipartPartRecord>>();
const checksumIndex = new Map<string, string>();

export function createSession(session: MultipartSession): void {
  sessions.set(session.fileId, session);
  if (session.uploadId) uploadIndex.set(session.uploadId, session.fileId);
  parts.set(session.fileId, new Map());
}

export function getSession(fileId: string, teamId: string): MultipartSession | null {
  const session = sessions.get(fileId);
  if (!session || session.teamId !== teamId) return null;
  return session;
}

export function getSessionByUploadId(uploadId: string, teamId: string): MultipartSession | null {
  const fileId = uploadIndex.get(uploadId);
  if (!fileId) return null;
  return getSession(fileId, teamId);
}

export function deleteSession(fileId: string): void {
  const session = sessions.get(fileId);
  if (session?.uploadId) uploadIndex.delete(session.uploadId);
  sessions.delete(fileId);
  parts.delete(fileId);
}

export function recordPart(
  fileId: string,
  partNumber: number,
  record: MultipartPartRecord,
  checksum?: string,
): void {
  const bucket = parts.get(fileId) ?? new Map<number, MultipartPartRecord>();
  bucket.set(partNumber, record);
  parts.set(fileId, bucket);
  if (checksum !== undefined) checksumIndex.set(`${fileId}:${partNumber}:${checksum}`, record.etag);
}

export function findPartByChecksum(
  fileId: string,
  partNumber: number,
  checksum: string,
): string | null {
  return checksumIndex.get(`${fileId}:${partNumber}:${checksum}`) ?? null;
}

export function listParts(fileId: string): Array<{ partNumber: number; etag: string }> {
  const bucket = parts.get(fileId);
  if (!bucket) return [];
  return [...bucket.entries()]
    .map(([partNumber, record]) => ({ partNumber, etag: record.etag }))
    .sort((a, b) => a.partNumber - b.partNumber);
}

export function totalSize(fileId: string): number {
  const bucket = parts.get(fileId);
  if (!bucket) return 0;
  return [...bucket.values()].reduce((sum, record) => sum + record.size, 0);
}

export function resetSessions(): void {
  sessions.clear();
  uploadIndex.clear();
  parts.clear();
  checksumIndex.clear();
}
