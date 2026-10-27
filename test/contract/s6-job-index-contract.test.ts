import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFERRED_OPERATION_MANIFEST,
  RUNTIME_ROUTE_REGISTRY,
  TARGET_CONTRACT_COUNTS,
} from '../../packages/contracts/src';

const root = join(import.meta.dirname, '../..');
const S6_OPERATIONS = [
  'API-JOB-CREATE',
  'API-JOB-RETRY',
  'API-JOB-CANCEL',
  'API-JOB-PAUSE',
  'API-JOB-RESUME',
  'API-JOB-REPLAY',
  'API-SEGMENT-BATCH',
  'API-SEGMENT-INDEX-CREATE',
  'API-SEGMENT-INDEX-UPDATE',
  'API-SEGMENT-INDEX-DELETE',
  'API-SEGMENT-HISTORY',
  'API-SEGMENT-REINDEX',
] as const;
const S7_OPERATIONS = [
  'API-SEARCH-SEMANTIC',
  'API-SEARCH-FULLTEXT',
  'API-SEARCH-HYBRID',
  'API-SEARCH-IMAGE',
  'API-SEARCH-MULTI',
] as const;

describe('S6 Job and index contract', () => {
  it('promotes exactly the 12 S6 operations and keeps S7 deferred', () => {
    const runtimeIds = new Set(RUNTIME_ROUTE_REGISTRY.map((operation) => operation.operationId));
    for (const operationId of S6_OPERATIONS) {
      expect(runtimeIds.has(operationId), operationId).toBe(true);
    }
    const deferredIds = new Set(
      DEFERRED_OPERATION_MANIFEST.map((operation) => operation.operationId),
    );
    for (const operationId of S7_OPERATIONS) {
      expect(runtimeIds.has(operationId), operationId).toBe(false);
      expect(deferredIds.has(operationId), operationId).toBe(true);
    }
    expect(RUNTIME_ROUTE_REGISTRY).toHaveLength(95);
    expect(DEFERRED_OPERATION_MANIFEST).toHaveLength(25);
    expect(TARGET_CONTRACT_COUNTS).toEqual({
      paths: 92,
      operations: 120,
      schemas: 139,
      parameters: 8,
    });
  });

  it('pins strict JobCreate, Reindex, index upsert and delete body contracts', () => {
    const openapi = JSON.parse(
      readFileSync(
        join(root, 'packages', 'contracts', 'openapi', 'knowledge-target.openapi.json'),
        'utf8',
      ),
    );
    const schemas = openapi.components.schemas;
    expect(schemas.JobCreate.additionalProperties).toBe(false);
    expect(schemas.JobCreate.properties.kind.enum).toEqual([
      'parse',
      'segment',
      'qa',
      'embed',
      'index',
      'fulltext',
      'rebuild',
    ]);
    expect(schemas.SegmentIndexUpsert.additionalProperties).toBe(false);
    expect(schemas.SegmentIndexUpsert.properties.type.enum).toEqual([
      'default',
      'custom',
      'question',
      'summary',
    ]);
    expect(schemas.ReindexRequest.required).toContain('version');
    expect(schemas.Segment.required).toEqual(
      expect.arrayContaining(['sourceVersion', 'fullTextTokens', 'fullTextVersion']),
    );
    const deletePath = openapi.paths['/v1/knowledge/segments/{segmentId}/indexes/{indexId}'].delete;
    expect(deletePath.requestBody.content['application/json'].schema.$ref).toContain(
      'VersionedMutation',
    );
  });

  it('declares four vector profiles and the canonical 13 queue registry', () => {
    const ddl = readFileSync(
      join(root, 'packages', 'service', 'src', 'shared', 'persistence', 'pgvector', 'ddl.ts'),
      'utf8',
    );
    expect(ddl.match(/knowledge_segment_vectors_(768|1024|1536|3072)/g)?.length).toBeGreaterThan(0);
    expect(ddl).toContain('halfvec_cosine_ops');
    const worker = readFileSync(
      join(root, 'projects', 'app', 'src', 'runtime', 'worker-registry.ts'),
      'utf8',
    );
    const workerEntry = readFileSync(
      join(root, 'projects', 'app', 'src', 'runtime', 'knowledge-worker.ts'),
      'utf8',
    );
    expect(worker).toContain('createWorkerRegistry');
    expect(worker).toContain('unknown_queue');
    expect(worker).toContain('repeated_registration');
    expect(workerEntry).toContain('KNOWLEDGE_QUEUE_NAMES.map');
    for (const queue of [
      'knowledge-import',
      'knowledge-parse',
      'knowledge-segment',
      'knowledge-qa',
      'knowledge-ocr',
      'knowledge-caption',
      'knowledge-embed',
      'knowledge-index',
      'knowledge-rebuild',
      'knowledge-sync',
      'knowledge-delete',
      'knowledge-outbox',
      'knowledge-cleanup',
    ]) {
      expect(workerEntry).toContain(`'${queue}'`);
    }
  });
});
