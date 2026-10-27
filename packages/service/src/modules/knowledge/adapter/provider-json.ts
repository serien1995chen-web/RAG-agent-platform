import { createKnowledgeError } from '@kb/contracts';
import { JSONPath } from 'jsonpath-plus';
import { CustomApiConnectorConfigSchema, CustomApiCredentialsSchema } from '@kb/contracts';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';

const FIXED_CUSTOM_API_PATHS = new Set([
  '/v1/file/list',
  '/v1/file/detail',
  '/v1/file/content',
  '/v1/file/read',
]);

export function validateCustomApiConfiguration(
  configValue: unknown,
  credentialsValue: unknown,
  context: TenantContext,
): {
  config: Record<string, unknown>;
  credentials: Record<string, unknown>;
} {
  const config = CustomApiConnectorConfigSchema.safeParse(configValue);
  const credentials = CustomApiCredentialsSchema.safeParse(credentialsValue);
  if (
    !config.success ||
    !credentials.success ||
    config.data.provider !== credentials.data.provider
  ) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_PROVIDER_CONFIG_INVALID',
      requestId: context.requestId,
      traceId: context.traceId,
      details: {
        configIssues: config.success ? [] : config.error.issues,
        credentialIssues: credentials.success ? [] : credentials.error.issues,
      },
    });
  }
  for (const path of [
    config.data.catalogPath,
    config.data.detailPath,
    config.data.contentPath,
    config.data.previewPath,
  ]) {
    if (!FIXED_CUSTOM_API_PATHS.has(path)) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_PROVIDER_CONFIG_INVALID',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { field: 'providerPath', reason: 'fixed_path_required' },
      });
    }
  }
  return {
    config: config.data as Record<string, unknown>,
    credentials: credentials.data as Record<string, unknown>,
  };
}

export function extractFixedPath<T = unknown>(value: unknown, path: string): T | undefined {
  if (!path.startsWith('$')) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_PROVIDER_CONFIG_INVALID',
      requestId: 'provider-json',
      traceId: 'provider-json',
      details: { reason: 'fixed_jsonpath_required' },
    });
  }
  const result = JSONPath({
    path,
    json: value as string | number | boolean | object | unknown[] | null,
    wrap: false,
  }) as T | undefined;
  return result;
}

export function providerContractError(
  provider: string,
  context: TenantContext,
  reason: string,
): never {
  throw createKnowledgeError({
    code: 'KNOWLEDGE_PROVIDER_CONTRACT_INVALID',
    requestId: context.requestId,
    traceId: context.traceId,
    details: { provider, reason },
  });
}

export function providerConfigError(
  provider: string,
  context: TenantContext,
  reason: string,
): never {
  throw createKnowledgeError({
    code: 'KNOWLEDGE_PROVIDER_CONFIG_INVALID',
    requestId: context.requestId,
    traceId: context.traceId,
    details: { provider, reason },
  });
}

export function dependencyStatusError(
  provider: string,
  providerStatus: number,
  context: TenantContext,
): never {
  throw createKnowledgeError({
    code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
    requestId: context.requestId,
    traceId: context.traceId,
    details: { provider, providerStatus, errorKind: 'auth' },
  });
}
