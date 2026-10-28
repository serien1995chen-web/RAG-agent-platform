import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFERRED_OPERATION_MANIFEST,
  RUNTIME_ROUTE_REGISTRY,
  TARGET_CONTRACT_COUNTS,
} from '../../packages/contracts/src';

const root = join(import.meta.dirname, '../..');
const S8_OPERATIONS = ['API-SEARCH-IMAGE', 'API-SEARCH-DEEP'] as const;
const S9_OPERATIONS = [
  'API-SYNONYM-GET',
  'API-SYNONYM-UPLOAD',
  'API-SYNONYM-UPDATE',
  'API-SYNONYM-DELETE',
  'API-SYNONYM-DOWNLOAD',
  'API-SYNONYM-MAPPINGS',
  'API-SYNONYM-ENABLE',
  'API-SYNONYM-REBUILD',
] as const;

describe('S8 contract and runtime closure', () => {
  it('retains the two S8 operations in the final S8 and S9 runtime union', () => {
    const runtime = new Set(RUNTIME_ROUTE_REGISTRY.map((route) => route.operationId));
    const deferred = new Set(DEFERRED_OPERATION_MANIFEST.map((route) => route.operationId));
    for (const operationId of S8_OPERATIONS) {
      expect(runtime.has(operationId), operationId).toBe(true);
      expect(deferred.has(operationId), operationId).toBe(false);
    }
    for (const operationId of S9_OPERATIONS) {
      expect(runtime.has(operationId), operationId).toBe(true);
      expect(deferred.has(operationId), operationId).toBe(false);
    }
    expect(RUNTIME_ROUTE_REGISTRY).toHaveLength(110);
    expect(DEFERRED_OPERATION_MANIFEST).toHaveLength(10);
    expect(TARGET_CONTRACT_COUNTS).toEqual({
      paths: 92,
      operations: 120,
      schemas: 139,
      parameters: 8,
    });
  });

  it('changes only DeepSearchRequest.maxRounds and keeps required Idempotency-Key', () => {
    const openapi = JSON.parse(
      readFileSync(join(root, 'packages/contracts/openapi/knowledge-target.openapi.json'), 'utf8'),
    );
    expect(
      openapi.components.schemas.DeepSearchRequest.allOf[1].properties.maxRounds,
    ).toMatchObject({
      minimum: 1,
      maximum: 3,
      default: 3,
    });
    expect(
      openapi.components.schemas.ImageSearchRequest.allOf[1].properties.imageUploadIds,
    ).toMatchObject({
      minItems: 1,
      maxItems: 10,
    });
    for (const path of ['/v1/knowledge/search/image', '/v1/knowledge/search/deep']) {
      const operation = openapi.paths[path].post;
      expect(
        operation.parameters.some(
          (parameter: { name: string; required: boolean }) =>
            parameter.name === 'Idempotency-Key' && parameter.required,
        ),
      ).toBe(true);
    }
  });
});
