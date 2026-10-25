import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { KnowledgeObjectContext } from '../object-store-contract';
import { objectStoreError } from '../object-store-contract';

export interface MaterializedBody {
  body: Buffer;
  sizeBytes: number;
  sha256: string;
}

export async function materializeBody(
  body: Uint8Array | Readable,
  declaredSizeBytes: number | undefined,
  context: KnowledgeObjectContext,
): Promise<MaterializedBody> {
  let resolved: Buffer;
  if (body instanceof Uint8Array) {
    resolved = Buffer.from(body);
  } else {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    resolved = Buffer.concat(chunks);
  }
  if (declaredSizeBytes !== undefined && resolved.byteLength !== declaredSizeBytes) {
    throw objectStoreError('KNOWLEDGE_VALIDATION_FAILED', context, {
      expectedSizeBytes: declaredSizeBytes,
      actualSizeBytes: resolved.byteLength,
    });
  }
  return {
    body: resolved,
    sizeBytes: resolved.byteLength,
    sha256: createHash('sha256').update(resolved).digest('hex'),
  };
}

export function readableFrom(value: unknown): Readable {
  if (value instanceof Readable) return value;
  if (value instanceof Uint8Array) return Readable.from([Buffer.from(value)]);
  if (
    typeof value === 'object' &&
    value !== null &&
    Symbol.asyncIterator in (value as Record<PropertyKey, unknown>)
  ) {
    return Readable.from(value as AsyncIterable<Uint8Array>);
  }
  if (typeof value === 'object' && value !== null && 'body' in value) {
    return readableFrom((value as { body: unknown }).body);
  }
  return Readable.from([]);
}

export function normalizedMetadata(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') result[key.toLowerCase()] = entry;
    else if (typeof entry === 'number') result[key.toLowerCase()] = String(entry);
  }
  return result;
}

export function headerValue(headers: unknown, name: string): string | null {
  if (typeof headers !== 'object' || headers === null) return null;
  const normalizedName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== normalizedName) continue;
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  }
  return null;
}

export function numericHeader(headers: unknown, name: string): number | null {
  const value = headerValue(headers, name);
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
