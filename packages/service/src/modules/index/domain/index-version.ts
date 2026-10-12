import { ApiErrorException, buildIndexVersion, createApiError } from '@kb/contracts';
import type { RequestContext } from '../../../ports/types';
import { validateTenantContext } from '../../../ports/types';

export const INDEX_SCHEMA_VERSION = 'v1' as const;
export const INDEX_VERSION_DIMENSION = 1536 as const;

export function generateIndexVersion(
  embeddingModelId: string,
  dimension: number = INDEX_VERSION_DIMENSION,
): string {
  if (embeddingModelId.length === 0) {
    throw new ApiErrorException(
      createApiError({
        code: 501050,
        requestId: 'index-version',
        params: {
          field: 'models.embeddingModel',
          value: embeddingModelId,
          rangeOrVersion: 'non-empty',
        },
      }),
    );
  }

  if (dimension !== INDEX_VERSION_DIMENSION) {
    throw new ApiErrorException(
      createApiError({
        code: 501013,
        requestId: 'index-version',
        params: { expected: INDEX_VERSION_DIMENSION, actual: dimension },
      }),
    );
  }

  return buildIndexVersion(embeddingModelId, dimension, INDEX_SCHEMA_VERSION);
}

export function buildVectorId(dataId: string, indexType: string, indexVersion: string): string {
  return `${dataId}:${indexType}:${indexVersion}`;
}

export function resolveQueryIndexVersion(
  input: { mode: 'latest' | 'pinned'; pinned?: string; currentVersion: string },
  context: RequestContext,
): string {
  const tenant = validateTenantContext(context.tenant, context.requestId);
  if (!tenant.ok) throw new ApiErrorException(tenant.error);

  if (input.mode === 'latest') return input.currentVersion;

  if (input.pinned !== input.currentVersion) {
    throw new ApiErrorException(
      createApiError({
        code: 501050,
        requestId: context.requestId,
        params: {
          field: 'versionPolicy.pinned',
          value: input.pinned,
          rangeOrVersion: input.currentVersion,
        },
      }),
    );
  }

  return input.pinned;
}
