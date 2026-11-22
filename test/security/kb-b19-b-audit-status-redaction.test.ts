import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { B19_B_RUN_ID, b19bTenantContext } from '../fixtures/b19-b/support';
import { S10StatusProbesAdapter } from '../../packages/service/src/modules/knowledge/adapter/s10-status-probes.adapter';

const root = resolve(import.meta.dirname, '../..');

describe('TEST-X-SECRET-LEAK / L1-B19-OPS-005-Q01 status evidence', () => {
  it('does not hard-code unverified audit and scope security checks as enabled', async () => {
    const source = await readFile(
      join(root, 'packages/service/src/modules/knowledge/adapter/s10-status-probes.adapter.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/scopeEnforced:\s*true/);
    expect(source).not.toMatch(/auditAppendOnly:\s*true/);
    expect(source).not.toMatch(/secretRedactionEnabled:\s*true/);
  });

  it.each([
    ['401', Object.assign(new Error('unauthorized'), { status: 401 })],
    ['403', Object.assign(new Error('forbidden'), { status: 403 })],
    ['404', Object.assign(new Error('not found'), { status: 404 })],
    ['429', Object.assign(new Error('rate limited'), { status: 429 })],
    ['500', Object.assign(new Error('server failed'), { status: 500 })],
    ['invalid-response', new Error('invalid provider response')],
    ['timeout', new Error('model_probe_timeout')],
  ])('keeps model probe failures %s observable and never verified', async (_label, error) => {
    const adapter = new S10StatusProbesAdapter({
      config: {
        externalModes: { model: 'real' },
        s3: { provider: 'minio' },
        s10: {
          apiKeyHmacConfigured: true,
          quota: { requestsPerMinute: 30 },
        },
      } as never,
      connection: {} as never,
      queues: new Map(),
      readiness: async () => ({
        status: 200,
        body: {
          checks: ['mongo', 'redis', 'postgres', 's3'].map((name) => ({
            name,
            status: 'ok',
            latencyMs: 1,
          })),
        },
      }),
      models: {
        async listModels() {
          throw error;
        },
      },
      modelHealth: {
        async probe() {
          throw error;
        },
      },
      connectors: {
        async list() {
          return [];
        },
      },
    });
    const context = b19bTenantContext(`model-${_label}`);
    const view = await adapter.probe(context);
    expect(view.modelProbe).toMatchObject({
      status: 'unavailable',
      verificationStatus: 'UNKNOWN',
    });
    expect(view.modelProbe.verificationStatus).not.toBe('REAL_VERIFIED');
    expect(
      (view.modelProbe as unknown as Record<string, unknown>).reason,
      `model probe failure ${_label} must expose a safe discriminated reason for operator UI`,
    ).toMatch(/model|provider|timeout|unauthorized|forbidden|not_found|rate|server|invalid/i);
  });

  it('does not expose workspace, connector, credential or object-key values in a status payload', async () => {
    const context = b19bTenantContext('redaction');
    const adapter = new S10StatusProbesAdapter({
      config: {
        externalModes: { model: 'mock' },
        s3: { provider: 'minio' },
        s10: {
          apiKeyHmacConfigured: true,
          quota: { requestsPerMinute: 30 },
        },
      } as never,
      connection: {} as never,
      queues: new Map(),
      readiness: async () => ({
        status: 200,
        body: {
          checks: ['mongo', 'redis', 'postgres', 's3'].map((name) => ({
            name,
            status: 'ok',
            latencyMs: 1,
          })),
        },
      }),
      models: {
        async listModels() {
          return [];
        },
      },
      connectors: {
        async list() {
          return [
            {
              connectorId: '65f1e5b2a1c9d4b7e8f01234',
              provider: 'feishu',
              status: 'failed',
              verificationStatus: 'EXTERNAL_UNVERIFIED',
              lastAttemptAt: new Date().toISOString(),
            },
          ];
        },
      },
    });
    const serialized = JSON.stringify(await adapter.probe(context));
    expect(serialized).not.toContain(B19_B_RUN_ID);
    expect(serialized).not.toContain('Bearer');
    expect(serialized).not.toContain('credentialCiphertext');
    expect(serialized).not.toContain('objectKey');
    expect(serialized).not.toContain('kn_live_');
  });
});
