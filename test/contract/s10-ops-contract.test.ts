import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KNOWLEDGE_ERROR_CATALOG } from '../../packages/contracts/src/errors/knowledge-errors';
import {
  buildKnowledgeContractArtifacts,
  RUNTIME_OPERATION_IDS,
} from '../../packages/contracts/src/openapi/openapi-builder.mjs';

const root = resolve(import.meta.dirname, '../..');
const artifacts = buildKnowledgeContractArtifacts(root);
const target = JSON.parse(
  readFileSync(join(root, 'packages/contracts/openapi/knowledge-target.openapi.json'), 'utf8'),
) as {
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components: { schemas: Record<string, Record<string, unknown>> };
};

const S10_OPERATIONS = [
  'API-APIKEY-LIST',
  'API-APIKEY-CREATE',
  'API-APIKEY-UPDATE',
  'API-APIKEY-DELETE',
  'API-APIKEY-ROTATE',
  'API-USAGE-GET',
  'API-AUDIT-LIST',
  'API-OPS-CLEANUP',
  'API-OPS-RECONCILE',
  'API-OPS-OUTBOX-REPLAY',
];

describe('S10 operations contract', () => {
  it('TEST-X-OPENAPI keeps 92/120/139/8 and promotes only the ten S10 operations', () => {
    expect(artifacts.actualCounts).toEqual({
      paths: 92,
      operations: 120,
      schemas: 139,
      parameters: 8,
    });
    expect(artifacts.runtimeRegistry.count).toBe(120);
    expect(artifacts.deferredManifest.count).toBe(0);
    const ids = new Set(artifacts.runtimeRegistry.operations.map((entry) => entry.operationId));
    for (const operationId of S10_OPERATIONS) expect(ids.has(operationId)).toBe(true);
    expect([...RUNTIME_OPERATION_IDS]).toHaveLength(120);
  });

  it('TEST-S10-NO-DEFERRED-FAKE generated artifacts contain no placeholder fallback', () => {
    const serialized = JSON.stringify({
      runtime: artifacts.runtimeRegistry,
      deferred: artifacts.deferredManifest,
    });
    expect(serialized).not.toContain('501999');
    expect(serialized).not.toContain('SKELETON_NOT_IMPLEMENTED');
    expect(artifacts.deferredManifest.operations).toEqual([]);
  });

  it('extends API Key schemas without exposing secretHash and requires delete version', () => {
    const apiKey = target.components.schemas.APIKey as {
      required: string[];
      properties: Record<string, Record<string, unknown>>;
    };
    expect(apiKey.required).toEqual(expect.arrayContaining(['version', 'updatedAt', 'createdAt']));
    expect(apiKey.properties.status.enum).toEqual(['active', 'rotated', 'revoked', 'expired']);
    expect(apiKey.properties).not.toHaveProperty('secretHash');
    const deleteOperation = target.paths['/v1/knowledge/api-keys/{keyId}'].delete;
    expect(deleteOperation.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'expectedVersion', in: 'query', required: true }),
      ]),
    );
    expect(KNOWLEDGE_ERROR_CATALOG.KNOWLEDGE_API_KEY_SCOPE_INVALID).toMatchObject({
      status: 422,
      retryable: false,
    });
  });

  it('exposes real usage, audit and status fields with outbox reconcile scope', () => {
    const usage = target.components.schemas.UsageSummary as {
      required: string[];
      properties: Record<string, Record<string, unknown>>;
    };
    expect(usage.required).toEqual(
      expect.arrayContaining(['delivery', 'series', 'profileVersion']),
    );
    const audit = target.components.schemas.AuditEvent as {
      properties: Record<string, unknown>;
    };
    expect(audit.properties).toEqual(
      expect.objectContaining({
        apiKeyPrefix: expect.anything(),
        requestId: expect.anything(),
        ipHash: expect.anything(),
        userAgentHash: expect.anything(),
        safeDiff: expect.anything(),
        expiresAt: expect.anything(),
      }),
    );
    const status = target.components.schemas.OpsStatus as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(status.properties).toHaveProperty('dependencies');
    expect(status.properties).toHaveProperty('securityChecks');
    expect(status.properties).toHaveProperty('connectorProbes');
    const reconcile = target.components.schemas.ReconcileCreate as {
      properties: { scope: { enum: string[] } };
    };
    expect(reconcile.properties.scope.enum).toContain('outbox');
  });
});
