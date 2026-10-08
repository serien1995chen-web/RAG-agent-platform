import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestContext } from '../../src/ports/types';
import { MongoDatasetAclRepository } from '../../src/modules/permission/repository/mongo-dataset-acl.repository';
import {
  DatasetAclSchema,
  DatasetSchema,
  type DatasetAclDoc,
  type DatasetDoc,
} from '../../src/shared/persistence/schemas';

const teamId = new mongoose.Types.ObjectId();
const ownerId = String(new mongoose.Types.ObjectId());
const memberId = String(new mongoose.Types.ObjectId());
const context: RequestContext = {
  requestId: 'req-acl-repo',
  tenant: { teamId: String(teamId), tmbId: memberId, authType: 'token', isRoot: false },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: false },
};

let replSet: MongoMemoryReplSet;
let connection: mongoose.Connection;
let repository: MongoDatasetAclRepository;
let datasets: mongoose.Model<DatasetDoc>;
let acl: mongoose.Model<DatasetAclDoc>;
let datasetId: string;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  connection = mongoose.createConnection(replSet.getUri('kb_acl_repository'));
  await connection.asPromise();
  datasets = connection.model<DatasetDoc>('Dataset', DatasetSchema);
  acl = connection.model<DatasetAclDoc>('DatasetAcl', DatasetAclSchema);
  await Promise.all([datasets.init(), acl.init()]);
  repository = new MongoDatasetAclRepository(connection);
}, 120_000);

beforeEach(async () => {
  await Promise.all([datasets.deleteMany({}), acl.deleteMany({})]);
  const dataset = await datasets.create({
    teamId,
    createdBy: new mongoose.Types.ObjectId(ownerId),
    parentId: null,
    type: 'knowledge',
    name: 'acl-dataset',
    vectorModel: 'bge-m3',
    indexVersion: 'bge-m3:1536:v1',
    inheritPermission: true,
    deleteTime: null,
  });
  datasetId = String(dataset._id);
});

afterAll(async () => {
  await connection.close();
  await replSet.stop();
});

describe('MongoDatasetAclRepository (P2-14 / PORT-PERM-001..003)', () => {
  it('keeps explicit deny at zero and gives Owner/Root all permissions', async () => {
    await acl.create({
      teamId,
      resourceType: 'dataset',
      resourceId: new mongoose.Types.ObjectId(datasetId),
      collaboratorType: 'member',
      collaboratorId: new mongoose.Types.ObjectId(memberId),
      permission: 0,
      permissionMask: 0,
      inheritEnabled: true,
      source: 'local',
    });
    const denied = await repository.getPermission(
      { datasetId, options: { timeoutMs: 5_000 } },
      context,
    );
    expect(denied.permissionMask).toBe(0);
    expect(denied.inherited).toBe(false);

    const owner = await repository.getPermission(
      { datasetId, options: { timeoutMs: 5_000 } },
      { ...context, tenant: { ...context.tenant, tmbId: ownerId } },
    );
    expect(owner.permissionMask).toBe(15);
  });

  it('unions inherited masks and protects the last owner', async () => {
    await acl.create({
      teamId,
      resourceType: 'dataset',
      resourceId: new mongoose.Types.ObjectId(datasetId),
      collaboratorType: 'group',
      collaboratorId: '*',
      permission: 3,
      permissionMask: 3,
      inheritEnabled: true,
      source: 'migrated',
    });
    const inherited = await repository.getPermission(
      { datasetId, options: { timeoutMs: 5_000 } },
      context,
    );
    expect(inherited.permissionMask).toBe(3);
    expect(inherited.inherited).toBe(true);

    await acl.create({
      teamId,
      resourceType: 'dataset',
      resourceId: new mongoose.Types.ObjectId(datasetId),
      collaboratorType: 'owner',
      collaboratorId: new mongoose.Types.ObjectId(ownerId),
      permission: 15,
      permissionMask: 15,
      inheritEnabled: true,
      source: 'local',
    });
    await expect(
      repository.updateCollaborators(
        {
          datasetId,
          expectedVersion: 1,
          collaborators: [
            {
              collaboratorType: 'member',
              collaboratorId: memberId,
              permissionMask: 1,
            },
          ],
          options: { timeoutMs: 5_000 },
        },
        context,
      ),
    ).rejects.toMatchObject({ error: { code: 501008 } });
  });

  it('inherits a member grant from an ancestor dataset', async () => {
    await acl.create({
      teamId,
      resourceType: 'dataset',
      resourceId: new mongoose.Types.ObjectId(datasetId),
      collaboratorType: 'member',
      collaboratorId: new mongoose.Types.ObjectId(memberId),
      permission: 1,
      permissionMask: 1,
      inheritEnabled: true,
      source: 'local',
    });
    const child = await datasets.create({
      teamId,
      createdBy: new mongoose.Types.ObjectId(ownerId),
      parentId: new mongoose.Types.ObjectId(datasetId),
      type: 'knowledge',
      name: 'acl-child',
      vectorModel: 'bge-m3',
      indexVersion: 'bge-m3:1536:v1',
      inheritPermission: true,
      deleteTime: null,
    });

    const inherited = await repository.getPermission(
      { datasetId: String(child._id), options: { timeoutMs: 5_000 } },
      context,
    );
    expect(inherited.permissionMask).toBe(1);
    expect(inherited.inherited).toBe(true);
  });

  it('resumes inheritance with CAS and deletes ACL with the resource transaction', async () => {
    const updated = await repository.resumeInherit(
      { datasetId, version: 1, options: { timeoutMs: 5_000 } },
      context,
    );
    expect(updated.version).toBe(2);
    await expect(
      repository.resumeInherit({ datasetId, version: 1, options: { timeoutMs: 5_000 } }, context),
    ).rejects.toMatchObject({ error: { code: 501067 } });
    await acl.create({
      teamId,
      resourceType: 'dataset',
      resourceId: new mongoose.Types.ObjectId(datasetId),
      collaboratorType: 'member',
      collaboratorId: new mongoose.Types.ObjectId(memberId),
      permission: 1,
      permissionMask: 1,
      inheritEnabled: true,
      source: 'local',
    });
    await repository.deleteResourceAcl({ datasetId, deleteDataset: true }, context);
    expect(await acl.countDocuments({ resourceId: new mongoose.Types.ObjectId(datasetId) })).toBe(
      0,
    );
    expect(await datasets.findById(datasetId)).toBeNull();
  });
});
