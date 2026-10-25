import { createHash } from 'node:crypto';

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sorted(item)]),
    );
  }
  return value;
}

export function requestHash(value: unknown): string {
  const hash = createHash('sha256');
  if (value instanceof Uint8Array) {
    hash.update(value);
  } else {
    hash.update(JSON.stringify(sorted(value)) ?? 'null');
  }
  return hash.digest('hex');
}

export function bodyByteLength(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (value instanceof Uint8Array) return value.byteLength;
  if (typeof value === 'string') return Buffer.byteLength(value);
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
