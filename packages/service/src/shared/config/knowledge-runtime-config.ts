import { readFileSync } from 'node:fs';
import { createKnowledgeError } from '@kb/contracts';
import { z } from 'zod';
import { ConfigValidationException } from './config-error';
import {
  loadS10PricingProfile,
  loadS10QuotaProfile,
  type S10PricingProfile,
  type S10QuotaProfile,
} from './s10-profiles';

const EnvironmentSchema = z.object({
  KB_ENV: z.enum(['development', 'test', 'production']).default('production'),
  NODE_ENV: z.string().optional(),
  KB_APP_WORKER_MODE: z.enum(['all', 'http', 'worker']).default('all'),
  KB_PORT: z.coerce.number().int().min(1).max(65535).default(3010),
  KB_INSTANCE_ID: z.string().min(1).max(128).default('knowledge-1'),
  KB_MONGO_URI: z.string().min(1),
  KB_REDIS_URL: z.string().min(1),
  KB_PG_URL: z.string().min(1),
  KB_S3_VENDOR: z.enum(['minio', 'aws-s3', 'r2', 'cos', 'oss']).default('minio'),
  KB_S3_ENDPOINT: z.string().url(),
  KB_S3_REGION: z.string().min(1).default('us-east-1'),
  KB_S3_BUCKET: z.string().min(1),
  KB_S3_ACCESS_KEY_REF: z.string().min(1),
  KB_S3_SECRET_KEY_REF: z.string().min(1),
  KB_FILE_PUBLIC_BASE_URL: z.string().url().default('http://localhost:3010'),
  KB_FILE_TICKET_SECRET_REF: z.string().min(1).default('env:KB_FILE_TICKET_SECRET'),
  KB_CREDENTIAL_ENCRYPTION_KEY_REF: z.string().min(1).default('env:KB_CREDENTIAL_ENCRYPTION_KEY'),
  KB_AUTH_MODE: z.enum(['mock', 'iam']).default('mock'),
  KB_MOCK_AUTH_TOKEN: z.string().min(16).optional(),
  KB_MOCK_WORKSPACE_ID: z.string().min(1).max(64).optional(),
  KB_MOCK_MEMBER_ID: z.string().min(1).max(128).optional(),
  KB_MOCK_SCOPES: z.string().default('knowledge:read,knowledge:write,knowledge:manage'),
  KB_MOCK_WORKSPACE_OWNER: z.enum(['true', 'false']).default('false'),
  API_KEY_HMAC_SECRET_FILE: z.string().trim().min(1).optional(),
  KB_USAGE_PRICING_PROFILE: z.enum(['zero-v1', 'fixture-v1']).optional(),
  KB_USAGE_PRICING_PROFILE_FILE: z.string().trim().min(1).optional(),
  KB_QUOTA_PROFILE: z.enum(['free-v1']).optional(),
  KB_QUOTA_PROFILE_FILE: z.string().trim().min(1).optional(),
  USAGE_INGEST_URL: z.string().url().optional(),
  USAGE_SNAPSHOT_URL: z.string().url().optional(),
  USAGE_SERVICE_TOKEN_FILE: z.string().trim().min(1).optional(),
  KB_EXTERNAL_MODEL_MODE: z.enum(['mock', 'real']).default('mock'),
  KB_EXTERNAL_OCR_MODE: z.enum(['mock', 'real']).default('mock'),
  KB_EXTERNAL_CONNECTOR_MODE: z.enum(['mock', 'real']).default('mock'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().url().optional(),
  ),
  KB_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export interface KnowledgeMockAuthConfig {
  token: string;
  workspaceId: string;
  memberId: string;
  scopes: string[];
  isWorkspaceOwner: boolean;
}

export interface KnowledgeRuntimeConfig {
  environment: 'development' | 'test' | 'production';
  workerMode: 'all' | 'http' | 'worker';
  port: number;
  instanceId: string;
  mongoUri: string;
  redisUrl: string;
  pgUrl: string;
  s3: {
    provider: 'minio' | 'aws-s3' | 'r2' | 'cos' | 'oss';
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyRef: string;
    secretKeyRef: string;
    credentialRefs: string[];
  };
  filePublicBaseUrl: string;
  fileTicketSecretRef: string;
  credentialEncryptionKeyRef: string;
  auth: { mode: 'mock'; fixture: KnowledgeMockAuthConfig } | { mode: 'iam' } | { mode: 'disabled' };
  s10: {
    apiKeyHmacSecret: string;
    apiKeyHmacConfigured: boolean;
    pricing: S10PricingProfile;
    quota: S10QuotaProfile;
    sharedUsage?: {
      ingestUrl?: string;
      snapshotUrl?: string;
      token: string;
    };
  };
  externalModes: {
    model: 'mock' | 'real';
    ocr: 'mock' | 'real';
    connector: 'mock' | 'real';
  };
  otelEndpoint?: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export function loadKnowledgeRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): KnowledgeRuntimeConfig {
  const parsed = EnvironmentSchema.safeParse(env);
  if (!parsed.success) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_INTERNAL_ERROR',
      requestId: 'config',
      traceId: 'config',
      details: {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    });
  }
  const data = parsed.data;
  if (data.KB_USAGE_PRICING_PROFILE && data.KB_USAGE_PRICING_PROFILE_FILE) {
    throw new ConfigValidationException(['KB_USAGE_PRICING_PROFILE 与文件不得同时配置']);
  }
  if (data.KB_QUOTA_PROFILE && data.KB_QUOTA_PROFILE_FILE) {
    throw new ConfigValidationException(['KB_QUOTA_PROFILE 与文件不得同时配置']);
  }
  const sharedUsageRequested = Boolean(data.USAGE_INGEST_URL || data.USAGE_SNAPSHOT_URL);
  if (sharedUsageRequested && !data.USAGE_SERVICE_TOKEN_FILE) {
    throw new ConfigValidationException([
      'USAGE_INGEST_URL/USAGE_SNAPSHOT_URL 配置时必须配置 USAGE_SERVICE_TOKEN_FILE',
    ]);
  }
  if (!data.API_KEY_HMAC_SECRET_FILE) {
    throw new ConfigValidationException(['API_KEY_HMAC_SECRET_FILE 未配置']);
  }
  let apiKeyHmacSecret: string;
  try {
    apiKeyHmacSecret = readFileSync(data.API_KEY_HMAC_SECRET_FILE, 'utf8').trim();
  } catch {
    throw new ConfigValidationException(['API_KEY_HMAC_SECRET_FILE 文件不可读']);
  }
  if (Buffer.byteLength(apiKeyHmacSecret, 'utf8') < 32) {
    throw new ConfigValidationException(['API_KEY_HMAC_SECRET_FILE 内容少于 32 bytes']);
  }
  let sharedUsageToken: string | undefined;
  if (sharedUsageRequested) {
    try {
      sharedUsageToken = readFileSync(data.USAGE_SERVICE_TOKEN_FILE!, 'utf8').trim();
    } catch {
      throw new ConfigValidationException(['USAGE_SERVICE_TOKEN_FILE 文件不可读']);
    }
    if (sharedUsageToken.length === 0) {
      throw new ConfigValidationException(['USAGE_SERVICE_TOKEN_FILE 内容为空']);
    }
  }
  const pricing = loadS10PricingProfile(env);
  const quota = loadS10QuotaProfile(env);
  const fixtureFields = [
    data.KB_MOCK_AUTH_TOKEN,
    data.KB_MOCK_WORKSPACE_ID,
    data.KB_MOCK_MEMBER_ID,
  ];
  const fixtureComplete = fixtureFields.every((value) => value !== undefined);
  const auth =
    data.KB_AUTH_MODE === 'iam'
      ? ({ mode: 'iam' } as const)
      : fixtureComplete
        ? ({
            mode: 'mock',
            fixture: {
              token: data.KB_MOCK_AUTH_TOKEN!,
              workspaceId: data.KB_MOCK_WORKSPACE_ID!,
              memberId: data.KB_MOCK_MEMBER_ID!,
              scopes: data.KB_MOCK_SCOPES.split(',')
                .map((scope) => scope.trim())
                .filter(Boolean),
              isWorkspaceOwner: data.KB_MOCK_WORKSPACE_OWNER === 'true',
            },
          } as const)
        : ({ mode: 'disabled' } as const);

  return {
    environment: data.KB_ENV,
    workerMode: data.KB_APP_WORKER_MODE,
    port: data.KB_PORT,
    instanceId: data.KB_INSTANCE_ID,
    mongoUri: data.KB_MONGO_URI,
    redisUrl: data.KB_REDIS_URL,
    pgUrl: data.KB_PG_URL,
    s3: {
      provider: data.KB_S3_VENDOR,
      endpoint: data.KB_S3_ENDPOINT,
      region: data.KB_S3_REGION,
      bucket: data.KB_S3_BUCKET,
      accessKeyRef: data.KB_S3_ACCESS_KEY_REF,
      secretKeyRef: data.KB_S3_SECRET_KEY_REF,
      credentialRefs: [data.KB_S3_ACCESS_KEY_REF, data.KB_S3_SECRET_KEY_REF],
    },
    filePublicBaseUrl: data.KB_FILE_PUBLIC_BASE_URL,
    fileTicketSecretRef: data.KB_FILE_TICKET_SECRET_REF,
    credentialEncryptionKeyRef: data.KB_CREDENTIAL_ENCRYPTION_KEY_REF,
    auth,
    s10: {
      apiKeyHmacSecret,
      apiKeyHmacConfigured: true,
      pricing,
      quota,
      ...(sharedUsageRequested
        ? {
            sharedUsage: {
              ...(data.USAGE_INGEST_URL ? { ingestUrl: data.USAGE_INGEST_URL } : {}),
              ...(data.USAGE_SNAPSHOT_URL ? { snapshotUrl: data.USAGE_SNAPSHOT_URL } : {}),
              token: sharedUsageToken!,
            },
          }
        : {}),
    },
    externalModes: {
      model: data.KB_EXTERNAL_MODEL_MODE,
      ocr: data.KB_EXTERNAL_OCR_MODE,
      connector: data.KB_EXTERNAL_CONNECTOR_MODE,
    },
    ...(data.OTEL_EXPORTER_OTLP_ENDPOINT ? { otelEndpoint: data.OTEL_EXPORTER_OTLP_ENDPOINT } : {}),
    logLevel: data.KB_LOG_LEVEL,
  };
}
