import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { TenantContext } from '../../../packages/service/src/shared/persistence/knowledge/tenant';

const fallbackTimestamp = new Date()
  .toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false })
  .replaceAll(':', '')
  .replaceAll(' ', '-');

export const B19_B_RUN_ID =
  process.env.B19_B_RUN_ID?.trim() ||
  `b19-b-${fallbackTimestamp}-${randomUUID().replaceAll('-', '').slice(0, 6)}`;
export const B19_B_SHORT_CODE =
  process.env.B19_B_SHORT_CODE?.trim() ||
  B19_B_RUN_ID.split('-').at(-1) ||
  randomUUID().replaceAll('-', '').slice(0, 6);
export const B19_B_WORKSPACE_A = `${B19_B_RUN_ID}-workspace-a`.slice(0, 64);
export const B19_B_WORKSPACE_B = `${B19_B_RUN_ID}-workspace-b`.slice(0, 64);
export const B19_B_DATABASE = `kb_test_b19b_${B19_B_SHORT_CODE}`;
export const B19_B_BUCKET = process.env.KB_TEST_S3_BUCKET || `kb-test-${B19_B_RUN_ID}`;

export function b19bEvidenceDir(): string {
  return resolve(
    process.env.B19_B_EVIDENCE_DIR || join(process.cwd(), 'test-results', 'b19-b', B19_B_RUN_ID),
  );
}

export async function writeB19BEvidence(name: string, value: unknown): Promise<void> {
  const target = join(b19bEvidenceDir(), name);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function b19bTraceId(fill = '0'): string {
  const suffix = sha256(B19_B_RUN_ID).slice(0, 32);
  return `${suffix.slice(0, 31)}${fill.slice(0, 1)}`;
}

export function b19bTenantContext(suffix: string, workspaceId = B19_B_WORKSPACE_A): TenantContext {
  return {
    workspaceId,
    memberId: `${B19_B_RUN_ID}-member-${suffix}`.slice(0, 128),
    requestId: `${B19_B_RUN_ID}-request-${suffix}`,
    traceId: b19bTraceId(suffix.slice(0, 1)),
    scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage', 'knowledge:admin'],
    isWorkspaceOwner: true,
    ipHash: sha256(`${B19_B_RUN_ID}:ip:${suffix}`),
    userAgentHash: sha256(`${B19_B_RUN_ID}:ua:${suffix}`),
  };
}

export function mongoUriForRun(baseUri: string): string {
  const url = new URL(baseUri);
  url.pathname = `/${B19_B_DATABASE}`;
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
    url.searchParams.set('directConnection', 'true');
  }
  return url.toString();
}

export function sanitizeB19BEvidence(value: string): string {
  return value
    .replace(/kn_live_[A-Za-z0-9_-]{24,}/g, '[REDACTED_API_KEY]')
    .replace(/mongodb(?:\+srv)?:\/\/[^\s"'\\]+/g, '[REDACTED_MONGO_URI]')
    .replace(/postgresql:\/\/[^\s"'\\]+/g, '[REDACTED_POSTGRES_URI]')
    .replace(/redis:\/\/[^\s"'\\]+/g, '[REDACTED_REDIS_URI]')
    .replace(/(Authorization:\s*Bearer\s+)[^\s"']+/gi, '$1[REDACTED]');
}
