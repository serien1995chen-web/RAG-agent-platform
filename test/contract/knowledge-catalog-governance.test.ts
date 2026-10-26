import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const openapi = JSON.parse(
  readFileSync(
    join(repositoryRoot, 'packages/contracts/openapi/knowledge-target.openapi.json'),
    'utf8',
  ),
) as {
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components: {
    schemas: Record<string, Record<string, unknown>>;
  };
};
const runtime = JSON.parse(
  readFileSync(
    join(repositoryRoot, 'packages/contracts/src/openapi/runtime-registry.data.json'),
    'utf8',
  ),
) as {
  count: number;
  operations: Array<{ operationId: string; capabilityIds: string[] }>;
};
const deferred = JSON.parse(
  readFileSync(
    join(repositoryRoot, 'packages/contracts/src/openapi/deferred-manifest.data.json'),
    'utf8',
  ),
) as { count: number; operations: Array<{ operationId: string }> };

const S3_OPERATIONS = [
  'API-SPACE-MOVE',
  'API-SPACE-BATCH',
  'API-SPACE-EXPORT',
  'API-SPACE-REFERENCES',
  'API-DIRECTORY-MOVE',
  'API-SOURCE-MOVE',
  'API-SOURCE-BATCH',
];

describe('S3 catalog governance contract', () => {
  it('promotes exactly the seven S3 operations at 65/55', () => {
    expect(runtime.count).toBe(65);
    expect(deferred.count).toBe(55);
    const runtimeIds = new Set(runtime.operations.map((operation) => operation.operationId));
    const deferredIds = new Set(deferred.operations.map((operation) => operation.operationId));
    for (const operationId of S3_OPERATIONS) {
      expect(runtimeIds.has(operationId), operationId).toBe(true);
      expect(deferredIds.has(operationId), operationId).toBe(false);
    }
    for (const operation of runtime.operations.filter((entry) =>
      S3_OPERATIONS.includes(entry.operationId),
    )) {
      expect(operation.capabilityIds).toContain('KB-003');
    }
  });

  it('keeps contract counts frozen and exposes path/batch/export fields', () => {
    expect(Object.keys(openapi.paths)).toHaveLength(92);
    expect(Object.keys(openapi.components.schemas)).toHaveLength(139);
    for (const schema of ['KnowledgeSpace', 'Directory', 'Source']) {
      expect(
        (openapi.components.schemas[schema]?.properties as Record<string, unknown>)?.parentPath,
      ).toBeDefined();
    }
    for (const schema of ['KnowledgeSpaceBatchAction', 'SourceBatchAction']) {
      expect(
        (openapi.components.schemas[schema]?.properties as Record<string, unknown>)?.versions,
      ).toBeDefined();
    }
    const exportCreate = openapi.components.schemas.ExportCreate as {
      properties: {
        format: { enum: string[]; default: string };
        sourceIds: { maxItems: number };
      };
    };
    expect(exportCreate.properties.format).toMatchObject({ enum: ['zip'], default: 'zip' });
    expect(exportCreate.properties.sourceIds.maxItems).toBe(2000);
  });
});
