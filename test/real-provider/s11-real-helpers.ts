import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const root = resolve(import.meta.dirname, '../..');

const SENSITIVE_KEY =
  /token|secret|password|credential|authorization|cookie|object[-_]?key|api[-_]?key/i;
const SAFE_TOKEN_USAGE_KEYS = new Set([
  'inputtokens',
  'outputtokens',
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
]);

function isSensitiveKey(keyHint: string): boolean {
  return !SAFE_TOKEN_USAGE_KEYS.has(keyHint.toLowerCase()) && SENSITIVE_KEY.test(keyHint);
}

export const providerContext: TenantContext = {
  workspaceId: 'ws_s11_real_provider',
  memberId: 'mem_s11_real_provider',
  requestId: 'req_s11_real_provider',
  traceId: 'trace_s11_real_provider',
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage'],
};

export function requiredProviderEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`S11_PROVIDER_REAL_BLOCKED: missing ${name}`);
  return value;
}

export function evidenceDirectory(): string {
  const configured = requiredProviderEnv('S11_EVIDENCE_DIR');
  const path = resolve(configured);
  const pathFromRoot = relative(root, path);
  if (pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))) {
    throw new Error('S11_EVIDENCE_DIR must be outside the worktree');
  }
  mkdirSync(path, { recursive: true });
  const realPath = realpathSync(path);
  const realFromRoot = relative(realpathSync(root), realPath);
  if (realFromRoot === '' || (!realFromRoot.startsWith('..') && !isAbsolute(realFromRoot))) {
    throw new Error('S11_EVIDENCE_DIR resolves inside the worktree');
  }
  return realPath;
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function safeHostHash(endpoint: string): string {
  return sha256(new URL(endpoint).host).slice(0, 16);
}

export function redactProviderEvidence(value: unknown, keyHint = ''): unknown {
  if (isSensitiveKey(keyHint)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redactProviderEvidence(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        redactProviderEvidence(item, key),
      ]),
    );
  }
  return value;
}

export function writeProviderEvidence(name: string, value: unknown): string {
  const path = join(evidenceDirectory(), name);
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        testId: 'TEST-X-S11-PROVIDER-REAL',
        generatedAt: new Date().toISOString(),
        candidateSha: process.env.CANDIDATE_SHA?.trim() || 'UNFROZEN',
        ...(redactProviderEvidence(value) as Record<string, unknown>),
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

export function fixturePdf(): Uint8Array {
  return readFileSync(join(root, 'test', 'fixtures', 's11', 'generated', 's11-two-page.pdf'));
}
