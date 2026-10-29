import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createKnowledgeError } from '@kb/contracts';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';

export const S10_API_KEY_SCOPES = Object.freeze([
  'knowledge:read',
  'knowledge:search',
  'knowledge:write',
  'knowledge:manage',
  'knowledge:admin',
] as const);

export type S10ApiKeyScope = (typeof S10_API_KEY_SCOPES)[number];
export type S10ApiKeyStatus = 'active' | 'rotated' | 'revoked' | 'expired';

export interface S10ApiKeyRecord {
  id: string;
  workspaceId: string;
  name: string;
  keyPrefix: string;
  scopes: S10ApiKeyScope[];
  spaceIds: string[];
  status: S10ApiKeyStatus;
  expiresAt: string | null;
  retireAt: string | null;
  lastUsedAt: string | null;
  rotatedFromKeyId: string | null;
  rotatedToKeyId: string | null;
  rotatedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface S10ApiKeyAuthRecord extends S10ApiKeyRecord {
  secretHash: string;
}

function invalidScope(context: TenantContext, scopes: readonly string[]): never {
  throw createKnowledgeError({
    code: 'KNOWLEDGE_API_KEY_SCOPE_INVALID',
    requestId: context.requestId,
    traceId: context.traceId,
    details: {
      allowed: S10_API_KEY_SCOPES,
      actual: scopes,
    },
  });
}

export function validateApiKeyScopes(
  scopes: readonly unknown[],
  context: TenantContext,
): S10ApiKeyScope[] {
  const normalized = scopes.map((scope) => String(scope));
  const unique = [...new Set(normalized)];
  if (
    unique.length === 0 ||
    unique.length !== normalized.length ||
    unique.some((scope) => !S10_API_KEY_SCOPES.includes(scope as S10ApiKeyScope))
  ) {
    invalidScope(context, normalized);
  }
  return unique as S10ApiKeyScope[];
}

export function generateApiKeySecret(random: (size: number) => Buffer = randomBytes): {
  secret: string;
  prefix: string;
} {
  const secret = `kn_live_${random(32).toString('base64url')}`;
  return { secret, prefix: secret.slice(0, 12) };
}

export function hashApiKeySecret(secret: string, hmacSecret: string): string {
  return createHmac('sha256', hmacSecret).update(secret).digest('hex');
}

export function matchesApiKeySecretHash(expectedHex: string, actualHex: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(expectedHex) || !/^[a-f0-9]{64}$/i.test(actualHex)) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = Buffer.from(actualHex, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function hashRequestIdentity(value: string | undefined): string {
  return createHash('sha256')
    .update(value?.trim() || 'unknown')
    .digest('hex');
}

export function defaultApiKeyExpiry(scopes: readonly S10ApiKeyScope[], now = new Date()): Date {
  const days = scopes.includes('knowledge:manage') || scopes.includes('knowledge:admin') ? 30 : 90;
  return new Date(now.getTime() + days * 86_400_000);
}

export function rotateApiKeyState(
  input: {
    status: S10ApiKeyStatus;
    expiresAt: Date | null;
  },
  now = new Date(),
): { retireAt: Date } {
  const overlapEnd = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return {
    retireAt:
      input.expiresAt && input.expiresAt.getTime() < overlapEnd.getTime()
        ? input.expiresAt
        : overlapEnd,
  };
}

export function effectiveApiKeyStatus(
  input: { status: S10ApiKeyStatus; expiresAt: Date | null; retireAt: Date | null },
  now = new Date(),
): S10ApiKeyStatus {
  if (input.status === 'revoked' || input.status === 'expired') return input.status;
  if (
    (input.expiresAt && input.expiresAt.getTime() <= now.getTime()) ||
    (input.retireAt && input.retireAt.getTime() <= now.getTime())
  ) {
    return 'expired';
  }
  return input.status;
}

export function isApiKeyUsable(
  input: { status: S10ApiKeyStatus; expiresAt: Date | null; retireAt: Date | null },
  now = new Date(),
): boolean {
  const status = effectiveApiKeyStatus(input, now);
  return status === 'active' || status === 'rotated';
}

export function isWorkspaceWideApiKey(spaceIds: readonly string[]): boolean {
  return spaceIds.length === 0;
}
