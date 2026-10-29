import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ConfigValidationException } from './config-error';

const MicrosSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const PricingCoreSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.enum(['zero-v1', 'fixture-v1']),
    currency: z.literal('points'),
    scaleMicros: z.literal(1_000_000),
    llmInputPer1kTokensMicros: MicrosSchema,
    llmOutputPer1kTokensMicros: MicrosSchema,
    embeddingPer1kTokensMicros: MicrosSchema,
    rerankPer1kTokensMicros: MicrosSchema,
    pageMicros: MicrosSchema,
    imageMicros: MicrosSchema,
    audioPerMinuteMicros: MicrosSchema,
  })
  .strict();

export const S10PricingProfileSchema = PricingCoreSchema.extend({
  version: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const S10QuotaProfileSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.literal('free-v1'),
    version: z.string().regex(/^[a-f0-9]{64}$/),
    retentionDays: z.literal(30),
    aiPointsLimit: z.literal(100),
    storageBytesLimit: z.literal(10 * 1024 * 1024 * 1024),
    maxSpaces: z.literal(3),
    maxIndexes: z.literal(600),
    requestsPerMinute: z.literal(30),
    maxModelConcurrency: z.literal(10),
  })
  .strict();

export type S10PricingProfile = z.infer<typeof S10PricingProfileSchema>;
export type S10PricingCore = z.infer<typeof PricingCoreSchema>;
export type S10QuotaProfile = z.infer<typeof S10QuotaProfileSchema>;

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function profileVersionOf(value: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function withVersion(core: S10PricingCore): S10PricingProfile {
  const parsed = PricingCoreSchema.safeParse(core);
  if (!parsed.success) {
    throw new ConfigValidationException(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  return { ...parsed.data, version: profileVersionOf(parsed.data) };
}

const ZERO_CORE: S10PricingCore = {
  schemaVersion: 1,
  name: 'zero-v1',
  currency: 'points',
  scaleMicros: 1_000_000,
  llmInputPer1kTokensMicros: 0,
  llmOutputPer1kTokensMicros: 0,
  embeddingPer1kTokensMicros: 0,
  rerankPer1kTokensMicros: 0,
  pageMicros: 0,
  imageMicros: 0,
  audioPerMinuteMicros: 0,
};

const FIXTURE_CORE: S10PricingCore = {
  schemaVersion: 1,
  name: 'fixture-v1',
  currency: 'points',
  scaleMicros: 1_000_000,
  llmInputPer1kTokensMicros: 1_000_000,
  llmOutputPer1kTokensMicros: 2_000_000,
  embeddingPer1kTokensMicros: 1_000_000,
  rerankPer1kTokensMicros: 1_000_000,
  pageMicros: 1_000_000,
  imageMicros: 1_000_000,
  audioPerMinuteMicros: 1_000_000,
};

const FREE_QUOTA_CORE = {
  schemaVersion: 1,
  name: 'free-v1',
  retentionDays: 30,
  aiPointsLimit: 100,
  storageBytesLimit: 10 * 1024 * 1024 * 1024,
  maxSpaces: 3,
  maxIndexes: 600,
  requestsPerMinute: 30,
  maxModelConcurrency: 10,
};

export const ZERO_V1_PRICING = withVersion(ZERO_CORE);
export const FIXTURE_V1_PRICING = withVersion(FIXTURE_CORE);
export const FREE_V1_QUOTA = S10QuotaProfileSchema.parse({
  ...FREE_QUOTA_CORE,
  version: profileVersionOf(FREE_QUOTA_CORE),
});

function readStrictProfile<T>(filePath: string, schema: z.ZodType<T>, label: string): T {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    throw new ConfigValidationException([`${label}: 文件不可读`]);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ConfigValidationException([`${label}: JSON 非法`]);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ConfigValidationException(
      parsed.error.issues.map((issue) => `${label}.${issue.path.join('.')}: ${issue.message}`),
    );
  }
  return parsed.data;
}

function assertProfileVersion(value: S10PricingProfile | S10QuotaProfile, label: string): void {
  const { version: _version, ...core } = value;
  if (profileVersionOf(core) !== value.version) {
    throw new ConfigValidationException([`${label}: version 与 canonical hash 不一致`]);
  }
}

export function loadS10PricingProfile(
  env: Readonly<Record<string, string | undefined>> = process.env,
): S10PricingProfile {
  const selected = env.KB_USAGE_PRICING_PROFILE?.trim();
  const file = env.KB_USAGE_PRICING_PROFILE_FILE?.trim();
  if (selected && file) {
    throw new ConfigValidationException(['pricing profile 名称与文件不得同时配置']);
  }
  if (file) {
    const parsed = readStrictProfile(file, S10PricingProfileSchema, 'pricing profile');
    assertProfileVersion(parsed, 'pricing profile');
    return parsed;
  }
  if (selected === 'fixture-v1') return FIXTURE_V1_PRICING;
  if (selected === undefined || selected === '' || selected === 'zero-v1') {
    return ZERO_V1_PRICING;
  }
  throw new ConfigValidationException([`pricing profile 未知: ${selected}`]);
}

export function loadS10QuotaProfile(
  env: Readonly<Record<string, string | undefined>> = process.env,
): S10QuotaProfile {
  const selected = env.KB_QUOTA_PROFILE?.trim();
  const file = env.KB_QUOTA_PROFILE_FILE?.trim();
  if (selected && file) {
    throw new ConfigValidationException(['quota profile 名称与文件不得同时配置']);
  }
  if (file) {
    const parsed = readStrictProfile(file, S10QuotaProfileSchema, 'quota profile');
    assertProfileVersion(parsed, 'quota profile');
    return parsed;
  }
  if (selected === undefined || selected === '' || selected === 'free-v1') {
    return FREE_V1_QUOTA;
  }
  throw new ConfigValidationException([`quota profile 未知: ${selected}`]);
}
