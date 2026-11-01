import { z } from 'zod';
import { ConfigValidationException } from './config-error';

type EnvSource = Readonly<Record<string, string | undefined>>;

function read(env: EnvSource, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

const SecretRefSchema = z
  .string()
  .regex(/^env:[A-Za-z_][A-Za-z0-9_]*$/, 'must be an env:<NAME> secret reference');

const HttpUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  }, 'must be an http(s) URL without embedded credentials');

export const S5AiproxyConfigSchema = z
  .object({
    mode: z.enum(['compose', 'external', 'openai']),
    baseUrl: HttpUrlSchema,
    apiTokenRef: SecretRefSchema,
    postgresUriRef: SecretRefSchema.nullable(),
    modelMode: z.enum(['mock', 'real']),
    providerOnly: z.array(z.string().min(1)).nullable(),
    rerankProtocol: z.enum(['openai', 'alibaba-native']),
  })
  .strict();

export type S5AiproxyConfig = z.infer<typeof S5AiproxyConfigSchema>;

function issuesOf(error: z.ZodError, prefix: string): string[] {
  return error.issues.map(
    (issue) => `${prefix}.${issue.path.join('.') || 'value'}: ${issue.message}`,
  );
}

/**
 * Validates AIProxy deployment configuration without resolving any secret value.
 * Secret references are retained so runtime factories resolve them explicitly.
 */
export function loadS5AiproxyConfig(env: EnvSource = process.env): S5AiproxyConfig {
  const modeValue = read(env, 'AIPROXY_MODE') ?? 'compose';
  const modeResult = z.enum(['compose', 'external', 'openai']).safeParse(modeValue);
  if (!modeResult.success) {
    throw new ConfigValidationException(issuesOf(modeResult.error, 'AIPROXY_MODE'));
  }
  const mode = modeResult.data;
  const modelMode = read(env, 'KB_EXTERNAL_MODEL_MODE') ?? 'mock';
  const explicitBaseUrl = read(env, 'AIPROXY_BASE_URL');
  const baseUrl = explicitBaseUrl ?? (mode === 'compose' ? 'http://aiproxy:3000' : undefined);
  const apiTokenRef = read(env, 'AIPROXY_API_TOKEN_REF') ?? 'env:AIPROXY_API_TOKEN';
  const postgresUriRef =
    read(env, 'AIPROXY_POSTGRES_URI_REF') ??
    (mode === 'compose' ? 'env:AIPROXY_POSTGRES_URI' : undefined);
  const tokenDanceGateway =
    explicitBaseUrl !== undefined &&
    (() => {
      try {
        return new URL(explicitBaseUrl).hostname === 'tokendance.space';
      } catch {
        return false;
      }
    })();
  const providerOnly =
    read(env, 'AIPROXY_PROVIDER_ONLY')
      ?.split(',')
      .map((value) => value.trim())
      .filter(Boolean) ?? (mode === 'openai' && tokenDanceGateway ? ['alibaba'] : null);
  const rerankProtocol =
    read(env, 'AIPROXY_RERANK_PROTOCOL') ??
    (mode === 'openai' && tokenDanceGateway ? 'alibaba-native' : 'openai');

  const parsed = S5AiproxyConfigSchema.safeParse({
    mode,
    baseUrl,
    apiTokenRef,
    postgresUriRef: postgresUriRef ?? null,
    modelMode,
    providerOnly,
    rerankProtocol,
  });
  if (!parsed.success) {
    throw new ConfigValidationException(issuesOf(parsed.error, 'AIPROXY'));
  }
  if ((mode === 'external' || mode === 'openai') && explicitBaseUrl === undefined) {
    throw new ConfigValidationException([`AIPROXY_BASE_URL: required in ${mode} mode`]);
  }
  if (mode === 'compose' && parsed.data.postgresUriRef === null) {
    throw new ConfigValidationException(['AIPROXY_POSTGRES_URI_REF: required in compose mode']);
  }
  if (parsed.data.modelMode === 'real' && !env.AIPROXY_API_TOKEN?.trim()) {
    throw new ConfigValidationException([
      'AIPROXY_API_TOKEN: must not be blank when KB_EXTERNAL_MODEL_MODE=real',
    ]);
  }
  return Object.freeze(parsed.data);
}
