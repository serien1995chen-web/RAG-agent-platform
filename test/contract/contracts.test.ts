import { describe, expect, it } from 'vitest';
import {
  ApiErrorException,
  ApiErrorSchema,
  DTO_SCHEMA_ERRORS,
  DTO_SPECS,
  ERROR_CATALOG,
  HealthResponseSchema,
  ROUTE_REGISTRY,
  SKELETON_NOT_IMPLEMENTED,
  classifyRetryableError,
  createApiError,
  createSkeletonError,
  datasetTypeRejection,
  dtoRegistry,
  getErrorMeta,
  missingDtoReferences,
  validateRouteRegistry,
} from '../../packages/contracts/src/index';

describe('error matrix (12.4 / 12.4.1 / 12.4.2)', () => {
  it('registers exactly 501001-501071 once each', () => {
    expect(ERROR_CATALOG.map((entry) => entry.code)).toEqual(
      Array.from({ length: 71 }, (_, index) => 501001 + index),
    );
  });

  it('gives every code a messageKey, HTTP status, retryability, severity and params schema', () => {
    for (const entry of ERROR_CATALOG) {
      expect(entry.messageKey, `code ${entry.code}`).toMatch(/^dataset\./);
      expect(
        [400, 403, 404, 409, 410, 413, 422, 429, 500, 502, 503, 504],
        `code ${entry.code}`,
      ).toContain(entry.httpStatus);
      expect(['retryable', 'no-retry', 'manual'], `code ${entry.code}`).toContain(entry.retryable);
      expect(['warning', 'error', 'fatal'], `code ${entry.code}`).toContain(entry.severity);
      expect(entry.paramsSchema.length, `code ${entry.code}`).toBeGreaterThan(0);
    }
  });

  it('builds schema-valid ApiError objects through the factory', () => {
    const error = createApiError({
      code: 501001,
      requestId: 'req-1',
      params: { type: 'websiteDataset' },
    });
    expect(ApiErrorSchema.parse(error)).toEqual(error);
    expect(error.messageKey).toBe('dataset.unsupported_type');
    expect(error.statusText).toBe('dataset.unsupported_type');
    expect(error.retryable).toBe('no-retry');
  });

  it('uses 501999 only for skeleton placeholders, outside the business matrix', () => {
    const skeleton = createSkeletonError({ route: 'API-DS-004' });
    expect(skeleton.code).toBe(SKELETON_NOT_IMPLEMENTED);
    expect(skeleton.messageKey).toBe('skeleton.not_implemented');
    expect(getErrorMeta(SKELETON_NOT_IMPLEMENTED)?.httpStatus).toBe(501);
    expect(ERROR_CATALOG.some((entry) => entry.code === SKELETON_NOT_IMPLEMENTED)).toBe(false);
  });

  it('classifies retryability only through classifyRetryableError', () => {
    const apiError = new ApiErrorException(
      createApiError({ code: 501014, requestId: 'req-retry' }),
    );
    expect(classifyRetryableError(apiError)).toBe('retryable');
    expect(classifyRetryableError({ code: 'ECONNRESET' })).toBe('retryable');
    expect(classifyRetryableError({ status: 503 })).toBe('retryable');
    expect(classifyRetryableError({ retryable: 'manual' })).toBe('manual');
    expect(classifyRetryableError(new Error('boom'))).toBe('manual');

    let zodError: unknown;
    try {
      dtoRegistry['Pagination']!.parse({ page: 'not-a-number' });
    } catch (error) {
      zodError = error;
    }
    expect(classifyRetryableError(zodError)).toBe('no-retry');
  });
});

describe('DTO registry (12.8.2)', () => {
  it('compiles every registered DTO without closure or duplicate-field errors', () => {
    expect(DTO_SCHEMA_ERRORS).toEqual([]);
    expect(missingDtoReferences()).toEqual([]);
    expect(DTO_SPECS).toHaveLength(199);
    for (const spec of DTO_SPECS) {
      if (spec.name === 'ApiResponse<T>') continue; // 泛型由 apiResponseSchema(data) 提供
      expect(dtoRegistry[spec.name], `DTO ${spec.name}`).toBeDefined();
    }
  });

  it('keeps requiredness: ApiError without requestId must fail validation', () => {
    const result = dtoRegistry['ApiError']!.safeParse({ code: 501001 });
    expect(result.success).toBe(false);
  });

  it('applies documented defaults and bounds for Pagination', () => {
    expect(dtoRegistry['Pagination']!.parse({})).toEqual({ page: 1, limit: 20, sortOrder: 'desc' });
    expect(dtoRegistry['Pagination']!.safeParse({ page: 1, limit: 101 }).success).toBe(false);
  });
});

describe('route registry (12.9)', () => {
  it('registers exactly 87 routes with the four minimal implementations', () => {
    expect(ROUTE_REGISTRY).toHaveLength(87);
    const implemented = ROUTE_REGISTRY.filter((route) => route.implemented)
      .map((route) => route.routeId)
      .sort();
    expect(implemented).toEqual(['API-DS-001', 'API-DS-002', 'API-DS-003', 'API-SEARCH-001']);
    expect(new Set(ROUTE_REGISTRY.map((route) => route.routeId)).size).toBe(87);
  });

  it('passes DTO closure, error-code registration and operation uniqueness checks', () => {
    expect(validateRouteRegistry()).toEqual([]);
  });

  it('declares stable error codes for every unimplemented route except live probe', () => {
    const missing = ROUTE_REGISTRY.filter(
      (route) =>
        !route.implemented && route.routeId !== 'API-HEALTH-001' && route.errorCodes.length === 0,
    ).map((route) => route.routeId);
    expect(missing).toEqual([]);
  });
});

describe('dataset type rejection (2.8)', () => {
  it('rejects websiteDataset and unknown types with 501001', () => {
    expect(datasetTypeRejection('websiteDataset')).toEqual({
      code: 501001,
      messageKey: 'dataset.unsupported_type',
      params: { type: 'websiteDataset' },
    });
    expect(datasetTypeRejection('unknown')).not.toBeNull();
    expect(datasetTypeRejection('dataset')).toBeNull();
  });
});

describe('health response (6.9)', () => {
  it('parses {status, checks, durationMs} without leaking extra fields', () => {
    const parsed = HealthResponseSchema.parse({
      status: 'ok',
      checks: [{ name: 'mongo', status: 'ok', durationMs: 1 }],
      durationMs: 2,
    });
    expect(parsed.checks).toHaveLength(1);
    expect(parsed.status).toBe('ok');
  });
});
