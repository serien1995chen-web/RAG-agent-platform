import { ApiErrorException, createApiError } from '@kb/contracts';

export const PREVIEW_URL_MIN_TTL_SECONDS = 3600;
export const PREVIEW_URL_MAX_TTL_SECONDS = 7200;
export const DEFAULT_PREVIEW_TTL_SECONDS = 3600;

export const CITATION_FORBIDDEN_KEYS = [
  'imageId',
  'objectKey',
  'providerResponse',
  'providerRaw',
  'storageKey',
] as const;

export function assertCitationSafe(candidate: Record<string, unknown>, requestId: string): void {
  const reject = (): never => {
    throw new ApiErrorException(
      createApiError({
        code: 501070,
        requestId,
        params: { resourceType: 'citation', resourceId: requestId },
      }),
    );
  };

  const forbidden = new Set<string>(CITATION_FORBIDDEN_KEYS);
  const stack: unknown[] = [candidate];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    if (typeof current !== 'object' || current === null) continue;
    for (const [key, value] of Object.entries(current)) {
      if (forbidden.has(key)) reject();
      if (typeof value === 'object' && value !== null) stack.push(value);
    }
  }

  const serialized = JSON.stringify(candidate);
  if (serialized.includes('providerResponse') || serialized.includes('objectKey')) reject();
}
