import { describe, expect, it } from 'vitest';
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

describe('runtime ObjectStore adapter (P1-2)', () => {
  it('maps temp/image keys to a team-only tenant context', () => {
    expect(tenantContextOf(context, { bucket: 'b', key: 'temp/team-a/a.txt' })).toEqual({
      teamId: 'team-a',
    });
    expect(tenantContextOf(context, { bucket: 'b', key: 'image/team-a/a.png' })).toEqual({
      teamId: 'team-a',
    });
  });

  it('derives datasetId from dataset-scoped keys', () => {
    expect(tenantContextOf(context, { bucket: 'b', key: 'dataset/ds-1/a.txt' })).toEqual({
      teamId: 'team-a',
      datasetId: 'ds-1',
    });
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
      },
      context,
    );
    expect(seen).toEqual([{ teamId: 'team-a', datasetId: 'ds-1' }]);
    expect(JSON.stringify(seen)).not.toContain('req-object-store');
  });
});
