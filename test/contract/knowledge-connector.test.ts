import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const openapi = JSON.parse(
  readFileSync(join(repoRoot, 'packages/contracts/openapi/knowledge-target.openapi.json'), 'utf8'),
) as { components: { schemas: Record<string, Record<string, unknown>> } };
const runtime = JSON.parse(
  readFileSync(join(repoRoot, 'packages/contracts/src/openapi/runtime-registry.data.json'), 'utf8'),
) as { count: number; operations: Array<{ operationId: string }> };

const CONNECTOR_OPERATIONS = [
  'API-CONNECTOR-CONNECT',
  'API-CONNECTOR-CATALOG',
  'API-CONNECTOR-IMPORT',
  'API-CONNECTOR-SYNC',
  'API-CONNECTOR-UPDATE',
  'API-CONNECTOR-GET',
  'API-CONNECTOR-DELETE',
];

describe('S4 connector contract', () => {
  it('registers all seven connector operations', () => {
    expect(runtime.count).toBe(110);
    const ids = new Set(runtime.operations.map((entry) => entry.operationId));
    for (const operationId of CONNECTOR_OPERATIONS) {
      expect(ids.has(operationId), operationId).toBe(true);
    }
  });

  it('exposes safe config and credential metadata without credentials/ciphertext', () => {
    const connector = openapi.components.schemas.Connector as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(connector.required).toContain('config');
    expect(connector.required).toContain('credentialMetadata');
    expect(connector.properties).toHaveProperty('config');
    expect(connector.properties).toHaveProperty('credentialMetadata');
    expect(connector.properties).not.toHaveProperty('credentials');
    expect(connector.properties).not.toHaveProperty('credentialCiphertext');
  });

  it('exposes nextCursor for both catalog responses', () => {
    for (const name of ['ConnectorCatalog', 'ApiLibraryCatalog']) {
      expect(
        (
          openapi.components.schemas[name] as {
            properties: Record<string, unknown>;
          }
        ).properties,
      ).toHaveProperty('nextCursor');
    }
  });
});
