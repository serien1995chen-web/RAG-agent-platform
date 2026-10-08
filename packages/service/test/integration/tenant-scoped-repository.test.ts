import { ApiErrorException, createApiError } from '@kb/contracts';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenantScopedModel, withMongoTransaction } from '../../src/shared/persistence/tenant';
import type { RequestContext } from '../../src/index';

const teamA = new mongoose.Types.ObjectId();
const teamB = new mongoose.Types.ObjectId();

const context: RequestContext = {
  requestId: 'req-tenant-scoped',
  tenant: { teamId: String(teamA), tmbId: 'tmb-a', authType: 'token', isRoot: false },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: false },
};

interface TenantItemDoc {
  teamId: mongoose.Types.ObjectId;
  name: string;
}

interface TenantAuditDoc {
  teamId: mongoose.Types.ObjectId;
  action: string;
}

let replSet: MongoMemoryReplSet;
let connection: mongoose.Connection;
let items: mongoose.Model<TenantItemDoc>;
let audits: mongoose.Model<TenantAuditDoc>;

function expectApiError(run: () => unknown, code: number): void {
  try {
    run();
    throw new Error(`expected ApiErrorException ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ApiErrorException);
    expect((error as ApiErrorException).error.code).toBe(code);
  }
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  connection = mongoose.createConnection(replSet.getUri());
  await connection.asPromise();
  items = connection.model<TenantItemDoc>(
    'TenantScopedItem',
    new mongoose.Schema<TenantItemDoc>(
      {
        teamId: { type: mongoose.Schema.Types.ObjectId, required: true },
        name: { type: String, required: true },
      },
      { collection: 'tenant_scoped_items', versionKey: false },
    ),
  );
  audits = connection.model<TenantAuditDoc>(
    'TenantScopedAudit',
    new mongoose.Schema<TenantAuditDoc>(
      {
        teamId: { type: mongoose.Schema.Types.ObjectId, required: true },
        action: { type: String, required: true },
      },
      { collection: 'tenant_scoped_audits', versionKey: false },
    ),
  );
  await Promise.all([items.init(), audits.init()]);
}, 300_000);

afterAll(async () => {
  await connection.close();
  await replSet.stop();
});

describe('tenant-scoped repositories (18.7 / 13.2)', () => {
  it('rejects a missing or invalid tenant context with 501012', () => {
    expectApiError(
      () =>
        tenantScopedModel(items, {
          ...context,
          tenant: { ...context.tenant, teamId: '' },
        }),
      501012,
    );
    expectApiError(
      () =>
        tenantScopedModel(items, {
          ...context,
          tenant: { ...context.tenant, teamId: 'not-an-object-id' },
        }),
      501012,
    );
  });

  it('scopes queries to the current team and overrides caller-provided teamId', async () => {
    await items.insertMany([
      { teamId: teamA, name: 'team-a-item' },
      { teamId: teamB, name: 'team-b-item' },
    ]);

    const scoped = tenantScopedModel(items, context);
    const ownDocs = await items.find(scoped.filter());
    expect(ownDocs.map((doc) => doc.name)).toEqual(['team-a-item']);

    const forced = await items.find(scoped.filter({ teamId: teamB }));
    expect(forced.map((doc) => doc.name)).toEqual(['team-a-item']);
  });

  it('rejects empty or cross-team documents with 501070', async () => {
    const scoped = tenantScopedModel(items, context);
    const foreign = await items.findOne({ teamId: teamB });

    expectApiError(() => scoped.assertOwned(null), 501070);
    expectApiError(() => scoped.assertOwned(foreign), 501070);

    const own = await items.findOne({ teamId: teamA });
    expect(scoped.assertOwned(own).name).toBe('team-a-item');
  });

  it('rolls back every write when a transaction fails', async () => {
    await expect(
      withMongoTransaction(connection, async (session) => {
        await items.create([{ teamId: teamA, name: 'rollback-item' }], { session });
        await audits.create([{ teamId: teamA, action: 'rollback' }], { session });
        throw new ApiErrorException(
          createApiError({
            code: 501070,
            requestId: 'tx-rollback',
            params: { resourceType: 'tenant_item', resourceId: '' },
          }),
        );
      }),
    ).rejects.toBeInstanceOf(ApiErrorException);

    expect(await items.countDocuments({ name: 'rollback-item' })).toBe(0);
    expect(await audits.countDocuments({ action: 'rollback' })).toBe(0);
  });

  it('commits both collections when the transaction succeeds', async () => {
    const result = await withMongoTransaction(connection, async (session) => {
      await items.create([{ teamId: teamA, name: 'commit-item' }], { session });
      await audits.create([{ teamId: teamA, action: 'commit' }], { session });
      return 'committed';
    });

    expect(result).toBe('committed');
    expect(await items.countDocuments({ name: 'commit-item' })).toBe(1);
    expect(await audits.countDocuments({ action: 'commit' })).toBe(1);
  });
});
