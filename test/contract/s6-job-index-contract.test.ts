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
  'API-SEARCH-MULTI',
  'API-CITATION-GET',
] as const;
const S8_OPERATIONS = ['API-SEARCH-IMAGE', 'API-SEARCH-DEEP'] as const;

describe('S6 Job and index contract', () => {
  it('retains the 12 S6 operations and registers S7 in phase2', () => {
    const runtimeIds = new Set(RUNTIME_ROUTE_REGISTRY.map((operation) => operation.operationId));
    for (const operationId of S6_OPERATIONS) {
      expect(runtimeIds.has(operationId), operationId).toBe(true);
    }
    const deferredIds = new Set(
      DEFERRED_OPERATION_MANIFEST.map((operation) => operation.operationId),
    );
    for (const operationId of S7_OPERATIONS) {
      expect(runtimeIds.has(operationId), operationId).toBe(true);
      expect(deferredIds.has(operationId), operationId).toBe(false);
    }
    for (const operationId of S8_OPERATIONS) {
      expect(runtimeIds.has(operationId), operationId).toBe(true);
      expect(deferredIds.has(operationId), operationId).toBe(false);
    }
    expect(RUNTIME_ROUTE_REGISTRY).toHaveLength(127);
    expect(DEFERRED_OPERATION_MANIFEST).toHaveLength(0);
    expect(TARGET_CONTRACT_COUNTS).toEqual({
      paths: 98,
      operations: 127,
      schemas: 149,
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

  it('L1-B13-A-TRAIN-001-Q02 exposes lease, epoch, attempts and terminal statuses in the Job contract', () => {
    const openapi = JSON.parse(
      readFileSync(
        join(root, 'packages', 'contracts', 'openapi', 'knowledge-target.openapi.json'),
        'utf8',
      ),
    );
    const job = openapi.components.schemas.Job;
    expect(job.required).toEqual(
      expect.arrayContaining([
        'jobId',
        'kind',
        'status',
        'attempts',
        'maxAttempts',
        'progress',
        'version',
      ]),
    );
    expect(job.properties).toEqual(
      expect.objectContaining({
        attemptEpoch: expect.objectContaining({ type: 'integer' }),
        leaseOwner: expect.anything(),
        leaseExpiresAt: expect.anything(),
        heartbeatAt: expect.anything(),
        steps: expect.objectContaining({ type: 'array' }),
      }),
    );
    expect(openapi.components.schemas.JobStatus.enum).toEqual(
      expect.arrayContaining([
        'queued',
        'leased',
        'running',
        'retry_wait',
        'paused',
        'cancelling',
        'cancelled',
        'failed',
        'dead_letter',
        'succeeded',
      ]),
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

  it('keeps deployment worker dependency resolution explicit', () => {
    const workerBuild = readFileSync(
      join(root, 'projects', 'app', 'tsdown.workers.config.ts'),
      'utf8',
    );
    const dockerfile = readFileSync(join(root, 'deploy', 'Dockerfile'), 'utf8');
    expect(workerBuild).toContain('node_modules/.pnpm/node_modules');
    expect(workerBuild).toContain("__kbJoin(__dirname, '../../../..')");
    expect(dockerfile).toContain(
      'ENV NODE_PATH=/app/node_modules/.pnpm/node_modules:/app/node_modules',
    );
  });

  it('L1-B13-B-TRAIN-005-N01 pins Job control states, scopes and versioned contracts', () => {
    const controls = new Map(
      RUNTIME_ROUTE_REGISTRY.filter((entry) =>
        [
          'API-JOB-RETRY',
          'API-JOB-CANCEL',
          'API-JOB-PAUSE',
          'API-JOB-RESUME',
          'API-JOB-REPLAY',
        ].includes(entry.operationId),
      ).map((entry) => [entry.operationId, entry]),
    );
    for (const operationId of [
      'API-JOB-RETRY',
      'API-JOB-CANCEL',
      'API-JOB-PAUSE',
      'API-JOB-RESUME',
    ]) {
      expect(controls.get(operationId)).toMatchObject({
        method: 'POST',
        requestSchema: 'VersionedMutation',
        responseSchema: 'Job',
        scopes: ['knowledge:write'],
        idempotent: true,
      });
    }
    expect(controls.get('API-JOB-REPLAY')).toMatchObject({
      method: 'POST',
      requestSchema: 'VersionedMutation',
      responseSchema: 'Job',
      scopes: ['knowledge:admin'],
      idempotent: true,
    });

    const openapi = JSON.parse(
      readFileSync(
        join(root, 'packages', 'contracts', 'openapi', 'knowledge-target.openapi.json'),
        'utf8',
      ),
    );
    expect(openapi.components.schemas.JobStatus.enum).toEqual(
      expect.arrayContaining([
        'queued',
        'leased',
        'running',
        'retry_wait',
        'paused',
        'cancelling',
        'cancelled',
        'failed',
        'dead_letter',
        'succeeded',
      ]),
    );
    expect(openapi.components.schemas.Job.required).toEqual(
      expect.arrayContaining([
        'attempts',
        'maxAttempts',
        'progress',
        'status',
        'version',
        'resourceType',
        'resourceId',
      ]),
    );
    expect(openapi.components.schemas.VersionedMutation).toMatchObject({
      required: ['version'],
      additionalProperties: false,
    });
  });
});
