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
  it('promotes exactly the seven import operations at 79/41', () => {
    expect(runtime.count).toBe(79);
    expect(deferred.count).toBe(41);
    const runtimeIds = new Set(runtime.operations.map((entry) => entry.operationId));
    const deferredIds = new Set(deferred.operations.map((entry) => entry.operationId));
    for (const operationId of IMPORT_OPERATIONS) {
      expect(runtimeIds.has(operationId), operationId).toBe(true);
      expect(deferredIds.has(operationId), operationId).toBe(false);
    }
  });

  it('maps import operations to S4 Capabilities only', () => {
    for (const operation of runtime.operations.filter((entry) =>
      IMPORT_OPERATIONS.includes(entry.operationId),
    )) {
      expect(
        operation.capabilityIds.some((id) => id.startsWith('ING-')),
        operation.operationId,
      ).toBe(true);
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
