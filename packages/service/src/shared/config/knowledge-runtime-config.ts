import { createKnowledgeError } from '@kb/contracts';
import { z } from 'zod';

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
    externalModes: {
      model: data.KB_EXTERNAL_MODEL_MODE,
      ocr: data.KB_EXTERNAL_OCR_MODE,
      connector: data.KB_EXTERNAL_CONNECTOR_MODE,
    },
    ...(data.OTEL_EXPORTER_OTLP_ENDPOINT ? { otelEndpoint: data.OTEL_EXPORTER_OTLP_ENDPOINT } : {}),
    logLevel: data.KB_LOG_LEVEL,
  };
}
