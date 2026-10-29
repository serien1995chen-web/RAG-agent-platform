import { describe, expect, it } from 'vitest';
import {
  DEFERRED_OPERATION_MANIFEST,
  FULL_ROUTE_REGISTRY,
  RUNTIME_ROUTE_REGISTRY,
  TARGET_CONTRACT_COUNTS,
} from '../../packages/contracts/src';

const expected = [
  {
    operationId: 'API-SYNONYM-GET',
    method: 'GET',
    path: '/v1/knowledge/spaces/{spaceId}/synonyms',
  },
  {
    operationId: 'API-SYNONYM-UPLOAD',
    method: 'POST',
    path: '/v1/knowledge/spaces/{spaceId}/synonyms/files',
  },
  {
    operationId: 'API-SYNONYM-UPDATE',
    method: 'PUT',
    path: '/v1/knowledge/spaces/{spaceId}/synonyms/files',
  },
  {
    operationId: 'API-SYNONYM-DELETE',
    method: 'DELETE',
    path: '/v1/knowledge/spaces/{spaceId}/synonyms',
  },
  {
    operationId: 'API-SYNONYM-DOWNLOAD',
    method: 'GET',
    path: '/v1/knowledge/spaces/{spaceId}/synonyms/files/{fileVersion}',
  },
  {
    operationId: 'API-SYNONYM-MAPPINGS',
    method: 'GET',
    path: '/v1/knowledge/spaces/{spaceId}/synonyms/mappings',
  },
  {
    operationId: 'API-SYNONYM-ENABLE',
    method: 'PATCH',
    path: '/v1/knowledge/spaces/{spaceId}/synonyms',
  },
  {
    operationId: 'API-SYNONYM-REBUILD',
    method: 'POST',
    path: '/v1/knowledge/spaces/{spaceId}/synonyms/rebuild',
  },
] as const;

describe('S9 synonym contract', () => {
  it('TEST-SEARCH-003-BLOCK registers exactly eight existing operations', () => {
    expect(TARGET_CONTRACT_COUNTS).toEqual({
      paths: 92,
      operations: 120,
      schemas: 139,
      parameters: 8,
    });
    expect(FULL_ROUTE_REGISTRY).toHaveLength(120);
    expect(RUNTIME_ROUTE_REGISTRY).toHaveLength(120);
    expect(DEFERRED_OPERATION_MANIFEST).toHaveLength(0);
    const full = new Map(FULL_ROUTE_REGISTRY.map((route) => [route.operationId, route]));
    const runtime = new Set(RUNTIME_ROUTE_REGISTRY.map((route) => route.operationId));
    const deferred = new Set(DEFERRED_OPERATION_MANIFEST.map((route) => route.operationId));
    for (const route of expected) {
      expect(full.get(route.operationId)).toMatchObject({
        method: route.method,
        path: route.path,
      });
      expect(runtime.has(route.operationId)).toBe(true);
      expect(deferred.has(route.operationId)).toBe(false);
    }
    expect(
      RUNTIME_ROUTE_REGISTRY.filter((route) => route.operationId.startsWith('API-SYNONYM-')),
    ).toHaveLength(8);
  });

  it('TEST-TRAIN-006-BLOCK keeps DTO/schema names unchanged', () => {
    const full = new Map(FULL_ROUTE_REGISTRY.map((route) => [route.operationId, route]));
    expect(full.get('API-SYNONYM-UPLOAD')).toMatchObject({
      responseSchema: 'SynonymConfig',
      idempotent: true,
    });
    expect(full.get('API-SYNONYM-UPDATE')).toMatchObject({
      responseSchema: 'SynonymConfig',
      idempotent: true,
    });
    expect(full.get('API-SYNONYM-MAPPINGS')).toMatchObject({
      responseSchema: 'SynonymMappingList',
    });
    expect(full.get('API-SYNONYM-REBUILD')).toMatchObject({
      requestSchema: 'VersionedMutation',
      responseSchema: 'Job',
      idempotent: true,
    });
  });
});
