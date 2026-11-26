import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const openapi = JSON.parse(
  readFileSync(join(repoRoot, 'packages/contracts/openapi/knowledge-target.openapi.json'), 'utf8'),
) as {
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components: { schemas: Record<string, Record<string, unknown>> };
};
const runtime = JSON.parse(
  readFileSync(join(repoRoot, 'packages/contracts/src/openapi/runtime-registry.data.json'), 'utf8'),
) as { count: number; operations: Array<{ operationId: string; capabilityIds: string[] }> };
const deferred = JSON.parse(
  readFileSync(
    join(repoRoot, 'packages/contracts/src/openapi/deferred-manifest.data.json'),
    'utf8',
  ),
) as { count: number; operations: Array<{ operationId: string }> };

const IMPORT_OPERATIONS = [
  'API-IMPORT-FILES',
  'API-IMPORT-IMAGES',
  'API-IMPORT-TEXT',
  'API-IMPORT-URL',
  'API-IMPORT-TEMPLATE',
  'API-IMPORT-BACKUP',
  'API-IMPORT-API-CATALOG',
  'API-IMPORT-API-DETAIL',
  'API-IMPORT-API-CONTENT',
  'API-IMPORT-API-PREVIEW',
  'API-IMPORT-API-LIBRARY',
];

describe('S4 import contract', () => {
  it('exposes real source retraining preview and submit contracts', () => {
    const operation = openapi.paths['/v1/knowledge/sources/{sourceId}/retrain']?.post;
    expect(operation?.operationId).toBe('API-SOURCE-RETRAIN');
    expect(openapi.components.schemas.RetrainSource).toBeDefined();
    expect(openapi.components.schemas.RetrainPreview).toBeDefined();
    expect(openapi.components.schemas.RetrainResult).toBeDefined();
    expect(runtime.operations.map((entry) => entry.operationId)).toContain('API-SOURCE-RETRAIN');
  });

  it('keeps exactly the eleven import operations in the W2 runtime', () => {
    expect(runtime.count).toBe(127);
    expect(deferred.count).toBe(0);
    const runtimeIds = new Set(runtime.operations.map((entry) => entry.operationId));
    const deferredIds = new Set(deferred.operations.map((entry) => entry.operationId));
    for (const operationId of IMPORT_OPERATIONS) {
      expect(runtimeIds.has(operationId), operationId).toBe(true);
      expect(deferredIds.has(operationId), operationId).toBe(false);
    }
  });

  it('maps import operations to S4 Capabilities only', () => {
    const expected = new Map([
      ['API-IMPORT-FILES', ['ING-001']],
      ['API-IMPORT-IMAGES', ['ING-001', 'MULTI-001']],
      ['API-IMPORT-TEXT', ['ING-002', 'DOWN-004']],
      ['API-IMPORT-URL', ['ING-003']],
      ['API-IMPORT-TEMPLATE', ['ING-004']],
      ['API-IMPORT-BACKUP', ['ING-005']],
      ['API-IMPORT-API-CATALOG', ['ING-006', 'API-002']],
      ['API-IMPORT-API-DETAIL', ['ING-006', 'API-002']],
      ['API-IMPORT-API-CONTENT', ['ING-006', 'API-002']],
      ['API-IMPORT-API-PREVIEW', ['ING-006', 'API-002']],
      ['API-IMPORT-API-LIBRARY', ['ING-006', 'API-002']],
      ['API-CONNECTOR-CONNECT', ['ING-007', 'ING-008', 'ING-009']],
      ['API-CONNECTOR-CATALOG', ['ING-007', 'ING-008', 'ING-009', 'OPS-005']],
      ['API-CONNECTOR-IMPORT', ['ING-007', 'ING-008', 'ING-009']],
      ['API-CONNECTOR-SYNC', ['ING-007', 'ING-008', 'ING-009']],
      ['API-CONNECTOR-UPDATE', ['ING-007', 'ING-008', 'ING-009']],
      ['API-CONNECTOR-GET', ['ING-007', 'ING-008', 'ING-009', 'OPS-005']],
      ['API-CONNECTOR-DELETE', ['ING-007', 'ING-008', 'ING-009']],
    ]);
    const actual = new Map(
      runtime.operations
        .filter((entry) => expected.has(entry.operationId))
        .map((entry) => [entry.operationId, entry.capabilityIds]),
    );
    expect(Object.fromEntries(actual)).toEqual(Object.fromEntries(expected));
    for (const capabilityIds of actual.values()) {
      expect(capabilityIds.some((id) => id.startsWith('PARSE-'))).toBe(false);
      expect(capabilityIds.some((id) => id.startsWith('FILE-'))).toBe(false);
    }
  });

  it('exposes backup dry-run/conflict fields and Job result plan fields', () => {
    const template = openapi.components.schemas.ImportTemplate as {
      properties: Record<string, { default?: unknown }>;
    };
    const backup = openapi.components.schemas.ImportBackup as {
      properties: Record<string, { default?: unknown; enum?: string[] }>;
    };
    expect(template.properties.previewOnly?.default).toBe(false);
    expect(backup.properties.dryRun?.default).toBe(false);
    expect(backup.properties.previewOnly?.default).toBe(false);
    expect(backup.properties.conflictStrategy?.enum).toEqual(['fail', 'skip', 'overwrite']);
    const result = (
      openapi.components.schemas.Job as {
        properties: { result: { oneOf: Array<{ properties: Record<string, unknown> }> } };
      }
    ).properties.result.oneOf[0];
    expect(result.properties).toHaveProperty('dryRun');
    expect(result.properties).toHaveProperty('conflicts');
    expect(result.properties).toHaveProperty('actions');
  });

  it('supports structured previews and the CSV restore round-trip', () => {
    const templatePath = openapi.paths['/v1/knowledge/spaces/{spaceId}/imports/template']?.post as {
      responses: Record<string, unknown>;
    };
    const backupPath = openapi.paths['/v1/knowledge/spaces/{spaceId}/imports/backup']?.post as {
      responses: Record<string, unknown>;
    };
    const exportSchema = openapi.components.schemas.ExportCreate as {
      properties: { format: { enum: string[] } };
    };
    expect(templatePath.responses).toHaveProperty('200');
    expect(backupPath.responses).toHaveProperty('200');
    expect(exportSchema.properties.format.enum).toEqual(['zip', 'csv']);
  });

  it('exposes a dedicated named image dataset import contract', () => {
    const path = openapi.paths['/v1/knowledge/spaces/{spaceId}/imports/images']?.post as {
      requestBody: {
        content: {
          'application/json': {
            schema: { $ref: string };
          };
        };
      };
    };
    expect(path.requestBody.content['application/json'].schema.$ref).toBe(
      '#/components/schemas/ImportImageDataset',
    );
    const schema = openapi.components.schemas.ImportImageDataset as {
      properties: {
        name: { maxLength: number };
        uploadIds: { minItems: number; maxItems: number };
      };
    };
    expect(schema.properties.name.maxLength).toBe(240);
    expect(schema.properties.uploadIds.minItems).toBe(1);
    expect(schema.properties.uploadIds.maxItems).toBe(5);
  });

  it('L1-B10-ING-003-001 exposes URL preview without adding a public path', () => {
    const urlPath = openapi.paths['/v1/knowledge/spaces/{spaceId}/imports/url']?.post as {
      requestBody: {
        content: {
          'application/json': {
            schema: { $ref: string };
          };
        };
      };
      responses: Record<string, unknown>;
    };
    expect(Object.keys(openapi.paths)).toHaveLength(98);
    expect(urlPath.responses).toHaveProperty('200');
    expect(urlPath.responses).toHaveProperty('202');
    expect(urlPath.requestBody.content['application/json'].schema.$ref).toBe(
      '#/components/schemas/ImportUrl',
    );

    const importUrl = openapi.components.schemas.ImportUrl as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(importUrl.required).toEqual(['url', 'selector', 'chunking']);
    expect(importUrl.properties).toHaveProperty('dryRun');
    expect(importUrl.properties).toHaveProperty('chunking');

    const preview = openapi.components.schemas.ImportUrlPreview as {
      required: string[];
      properties: { chunks: { maxItems: number } };
    };
    expect(preview.required).toEqual([
      'title',
      'safeUrl',
      'selector',
      'contentHash',
      'totalChunks',
      'chunks',
      'truncated',
    ]);
    expect(preview.properties.chunks.maxItems).toBe(10);
  });
});
