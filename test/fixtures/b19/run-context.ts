import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface B19RunContext {
  runId: string;
  shortCode: string;
  mongoDatabase: string;
  evidenceDir: string;
  workspaceA: string;
  workspaceB: string;
  memberOwner: string;
  memberReader: string;
  adminToken: string;
  noScopeToken: string;
  redisUrl: string;
  objectBucket: string;
}

const root = resolve(import.meta.dirname, '../../..');

function compactTimestamp(value: Date): string {
  return value
    .toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false })
    .replaceAll('-', '')
    .replaceAll(' ', '-')
    .replaceAll(':', '');
}

function defaultRunId(now = new Date()): string {
  return `b19-a-${compactTimestamp(now)}-${randomBytes(3).toString('hex')}`;
}

function requiredRedisUrl(): string {
  const value = process.env.KB_TEST_REDIS_URL?.trim();
  if (!value) throw new Error('missing required test environment: KB_TEST_REDIS_URL');
  return value;
}

export function b19RunContext(
  input: {
    runId?: string;
    now?: Date;
    env?: NodeJS.ProcessEnv;
  } = {},
): B19RunContext {
  const env = input.env ?? process.env;
  const runId = input.runId?.trim() || env.B19_RUN_ID?.trim() || defaultRunId(input.now);
  if (!/^b19-a-\d{8}-\d{6}-[a-z0-9]{4,12}$/.test(runId)) {
    throw new Error(`invalid B19 runId: ${runId}`);
  }
  const shortCode = runId.slice(-runId.split('-').at(-1)!.length);
  const evidenceDir = resolve(
    env.B19_EVIDENCE_DIR?.trim() || join(root, 'test-results', 'b19-a', runId),
  );
  mkdirSync(evidenceDir, { recursive: true });
  return {
    runId,
    shortCode,
    mongoDatabase: `kb_test_b19a_${shortCode}`,
    evidenceDir,
    workspaceA: `${runId}-workspace-a`,
    workspaceB: `${runId}-workspace-b`,
    memberOwner: `${runId}-member-owner`,
    memberReader: `${runId}-member-reader`,
    adminToken: `${runId}-admin-token`,
    noScopeToken: `${runId}-no-scope-token`,
    redisUrl: requiredRedisUrl(),
    objectBucket: env.B19_OBJECT_BUCKET?.trim() || `b19-a-${shortCode}`,
  };
}

export function redactEvidenceText(value: string): string {
  return value
    .replace(/kn_live_[A-Za-z0-9_-]{24,}/g, '[REDACTED_API_KEY]')
    .replace(/mongodb(?:\+srv)?:\/\/[^\s"'\\]+/g, '[REDACTED_MONGO_URI]')
    .replace(/postgresql:\/\/[^\s"'\\]+/g, '[REDACTED_POSTGRES_URI]')
    .replace(/redis:\/\/[^\s"'\\]+/g, '[REDACTED_REDIS_URI]')
    .replace(/(Authorization:\s*Bearer\s+)[^\s"']+/gi, '$1[REDACTED]');
}

export function writeB19Evidence(
  context: Pick<B19RunContext, 'evidenceDir'>,
  relativePath: string,
  value: unknown,
): string {
  const target = resolve(context.evidenceDir, relativePath);
  if (!target.startsWith(`${context.evidenceDir}/`)) {
    throw new Error('B19 evidence path escapes the run directory');
  }
  mkdirSync(resolve(target, '..'), { recursive: true });
  const rendered =
    typeof value === 'string'
      ? redactEvidenceText(value)
      : JSON.stringify(value, null, 2).replace(
          /("(?:secret|authorization|cookie|connectionString)"\s*:\s*)"[^"]*"/gi,
          '$1"[REDACTED]"',
        );
  writeFileSync(target, `${rendered}\n`);
  return target;
}
