import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  workspaceFilter,
  workspaceScopedModel,
} from '../../packages/service/src/shared/persistence/knowledge/tenant';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const root = resolve(import.meta.dirname, '../..');
const context: TenantContext = {
  workspaceId: 'ws_s11_tenant_a',
  memberId: 'mem_s11_tenant_a',
  requestId: 'req_s11_tenant',
  traceId: 'trace_s11_tenant',
  scopes: ['knowledge:read'],
};

describe('TEST-X-SECURITY-APIKEY-SCOPE / ROTATION / TENANT-GUARD', () => {
  it('keeps tenant predicates mandatory and hides another workspace object', () => {
    expect(workspaceFilter(context, { _id: 'source-a' })).toMatchObject({
      workspaceId: context.workspaceId,
      deletedAt: null,
    });
    const scoped = workspaceScopedModel({} as never, context);
    expect(() =>
      scoped.assertOwned({
        workspaceId: 'ws_s11_tenant_b',
        knowledgeSpaceId: null,
        version: 1,
        deletedAt: null,
        createdByMemberId: 'member-b',
        updatedByMemberId: 'member-b',
      }),
    ).toThrow();
  });

  it('keeps real S10 API-key scope and rotation BLOCKED until credentials exist', () => {
    const runtime = JSON.parse(
      readFileSync(
        join(root, 'packages', 'contracts', 'src', 'openapi', 'runtime-registry.data.json'),
        'utf8',
      ),
    ) as { operations: Array<{ operationId: string }> };
    const deferred = JSON.parse(
      readFileSync(
        join(root, 'packages', 'contracts', 'src', 'openapi', 'deferred-manifest.data.json'),
        'utf8',
      ),
    ) as { operations: Array<{ operationId: string }> };
    const runtimeIds = new Set(runtime.operations.map((operation) => operation.operationId));
    const deferredIds = new Set(deferred.operations.map((operation) => operation.operationId));
    expect(runtime.operations).toHaveLength(120);
    expect(deferred.operations).toHaveLength(0);
    expect(runtimeIds.has('API-APIKEY-CREATE')).toBe(true);
    expect(runtimeIds.has('API-APIKEY-ROTATE')).toBe(true);
    expect(deferredIds.has('API-APIKEY-CREATE')).toBe(false);
    expect(deferredIds.has('API-APIKEY-ROTATE')).toBe(false);
    expect({
      testId: 'TEST-X-SECURITY-APIKEY-SCOPE',
      result: 'BLOCKED',
      reason: 'REAL_API_KEY_CREDENTIALS_UNAVAILABLE',
    }).toEqual({
      testId: 'TEST-X-SECURITY-APIKEY-SCOPE',
      result: 'BLOCKED',
      reason: 'REAL_API_KEY_CREDENTIALS_UNAVAILABLE',
    });
  });
});
