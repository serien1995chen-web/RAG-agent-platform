import { describe, expect, it } from 'vitest';
import { ERROR_CATALOG_BY_CODE, ROUTE_REGISTRY_BY_ID } from '../../packages/contracts/src/index';

/**
 * ISSUE-005 / ISSUE-006：DTO 校验失败必须走 400 家族的通用输入错误码，
 * 不得复用配额（501071）、存储（501013）或 Provider（501019）语义码。
 */
describe('request validation error mapping (ISSUE-005/006)', () => {
  it('registers dataset.request.invalid as a 400 no-retry warning', () => {
    const entry = ERROR_CATALOG_BY_CODE.get(501072);
    expect(entry).toMatchObject({
      code: 501072,
      messageKey: 'dataset.request.invalid',
      httpStatus: 400,
      retryable: 'no-retry',
      severity: 'warning',
    });
    expect(entry?.paramsSchema).toBe('{route,field}');
  });

  it.each(['API-DATA-005', 'API-DS-006', 'API-COL-015'])(
    '%s declares 501072 alongside its semantic error codes',
    (routeId) => {
      const route = ROUTE_REGISTRY_BY_ID.get(routeId);
      expect(route).toBeDefined();
      expect(route?.errorCodes).toContain(501072);
    },
  );

  it('keeps quota/vector/provider semantics untouched', () => {
    expect(ERROR_CATALOG_BY_CODE.get(501071)?.httpStatus).toBe(429);
    expect(ERROR_CATALOG_BY_CODE.get(501013)?.httpStatus).toBeGreaterThanOrEqual(500);
    expect(ERROR_CATALOG_BY_CODE.get(501019)?.httpStatus).toBe(502);
  });
});
