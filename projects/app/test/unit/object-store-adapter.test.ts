import { describe, expect, it, vi } from 'vitest';
import {
  createRuntimeObjectStorePort,
  tenantContextOf,
} from '../../src/runtime/object-store-adapter';
import type { RequestContext } from '../../../../packages/service/src/index';

const context: RequestContext = {
  requestId: 'req-object-store',
  tenant: { teamId: 'team-a', tmbId: 'tmb-a', authType: 'internal', isRoot: false },
  permission: { canRead: true, canWrite: true, canManage: false, isOwner: false },
};

function codeOf(work: () => unknown): number {
  try {
    work();
    throw new Error('expected throw');
  } catch (error) {
    const apiError = (error as { error?: { code?: number } }).error;
    if (!apiError) throw error;
    return apiError.code ?? 0;
  }
}

describe('runtime ObjectStore adapter (P1-1 授权作用域)', () => {
  it('maps temp/image keys to a team-only tenant context', () => {
    expect(tenantContextOf(context, { bucket: 'b', key: 'temp/team-a/a.txt' })).toEqual({
      teamId: 'team-a',
    });
    expect(tenantContextOf(context, { bucket: 'b', key: 'image/team-a/a.png' })).toEqual({
      teamId: 'team-a',
    });
  });

  it('accepts a dataset key matching the authorized datasetId', () => {
    expect(tenantContextOf(context, { bucket: 'b', key: 'dataset/ds-1/a.txt' }, 'ds-1')).toEqual({
      teamId: 'team-a',
      datasetId: 'ds-1',
    });
  });

  it('rejects a dataset key that does not match the authorized datasetId', () => {
    expect(
      codeOf(() => tenantContextOf(context, { bucket: 'b', key: 'dataset/ds-2/secret' }, 'ds-1')),
    ).toBe(501061);
  });

  it('rejects a dataset key when no datasetId is authorized', () => {
    expect(codeOf(() => tenantContextOf(context, { bucket: 'b', key: 'dataset/ds-1/a.txt' }))).toBe(
      501061,
    );
  });

  it('blocks the call before touching storage when the scope mismatches', async () => {
    const get = vi.fn(async () => ({ ref: {}, body: new Uint8Array() }));
    const port = createRuntimeObjectStorePort({ get } as never);
    await expect(
      port.get(
        {
          ref: { bucket: 'b', key: 'dataset/ds-2/secret' },
          options: { timeoutMs: 1000 },
          datasetId: 'ds-1',
        },
        context,
      ),
    ).rejects.toMatchObject({ error: { code: 501061 } });
    expect(get).not.toHaveBeenCalled();
  });

  it('delegates with a TenantObjectContext, never the RequestContext', async () => {
    const seen: unknown[] = [];
    const storage = {
      put: async (input: { ref: unknown }, ctx: unknown) => {
        seen.push(ctx);
        return input.ref;
      },
    } as never;
    const port = createRuntimeObjectStorePort(storage);
    await port.put(
      {
        ref: { bucket: 'b', key: 'dataset/ds-1/a.txt' },
        body: new Uint8Array([1]),
        options: { timeoutMs: 1000 },
        datasetId: 'ds-1',
      },
      context,
    );
    expect(seen).toEqual([{ teamId: 'team-a', datasetId: 'ds-1' }]);
    expect(JSON.stringify(seen)).not.toContain('req-object-store');
  });
});
