import { createHmac, timingSafeEqual } from 'node:crypto';

export interface ConsoleSessionPayload {
  workspaceId: string;
  memberId: string;
  scopes: string[];
  isWorkspaceOwner: boolean;
  expiresAt: number;
}

function signature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function createConsoleSession(
  payload: Omit<ConsoleSessionPayload, 'expiresAt'>,
  secret: string,
  ttlSeconds = 3600,
): string {
  const encoded = Buffer.from(
    JSON.stringify({
      ...payload,
      expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
    }),
    'utf8',
  ).toString('base64url');
  return `${encoded}.${signature(encoded, secret)}`;
}

export function verifyConsoleSession(token: string, secret: string): ConsoleSessionPayload | null {
  const [encoded, supplied] = token.split('.');
  if (!encoded || !supplied) return null;
  const expected = signature(encoded, secret);
  const actualBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as ConsoleSessionPayload;
    if (payload.expiresAt <= Math.floor(Date.now() / 1000)) return null;
    if (!payload.workspaceId || !payload.memberId || !Array.isArray(payload.scopes)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
