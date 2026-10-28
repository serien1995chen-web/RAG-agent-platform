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
  'API-IMPORT-TEXT',
  'API-IMPORT-URL',
  'API-IMPORT-TEMPLATE',
  'API-IMPORT-BACKUP',
  'API-IMPORT-API-CATALOG',
  'API-IMPORT-API-LIBRARY',
];

describe('S4 import contract', () => {
  it('keeps exactly the seven import operations in the W1 runtime', () => {
    expect(runtime.count).toBe(95);
    expect(deferred.count).toBe(25);
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
      ['API-IMPORT-TEXT', ['ING-002', 'DOWN-004']],
      ['API-IMPORT-URL', ['ING-003']],
      ['API-IMPORT-TEMPLATE', ['ING-004']],
      ['API-IMPORT-BACKUP', ['ING-005']],
      ['API-IMPORT-API-CATALOG', ['ING-006', 'API-002']],
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
    const backup = openapi.components.schemas.ImportBackup as {
      properties: Record<string, { default?: unknown; enum?: string[] }>;
    };
    expect(backup.properties.dryRun?.default).toBe(false);
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
});
