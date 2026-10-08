import { ApiErrorException, createApiError } from '@kb/contracts';
import { Types, type Connection, type Model } from 'mongoose';
import type {
  CollaboratorPermission,
  DatasetPermissionPort,
  PermissionSnapshotValue,
} from '../../../ports/capabilities';
import type { RequestContext } from '../../../ports/types';
import {
  DatasetAclSchema,
  DatasetSchema,
  type DatasetAclDoc,
  type DatasetDoc,
} from '../../../shared/persistence/schemas';
import { withMongoTransaction } from '../../../shared/persistence/with-mongo-transaction';
import {
  ACL_PERMISSION_ALL,
  canRemoveLastOwner,
  evaluatePermissionMask,
  mergePermissionMasks,
} from '../domain';

function toOid(value: string, field: string, requestId: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(value)) {
    throw new ApiErrorException(
      createApiError({
        code: 501070,
        requestId,
        params: { resourceType: field, resourceId: value },
      }),
    );
  }
  return new Types.ObjectId(value);
}

function versionConflict(
  datasetId: string,
  expectedVersion: number,
  actualVersion: number,
  requestId: string,
): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code: 501067,
      requestId,
      params: {
        resourceType: 'dataset',
        resourceId: datasetId,
        expectedVersion,
        actualVersion,
      },
    }),
  );
}

export class MongoDatasetAclRepository implements DatasetPermissionPort {
  private readonly connection: Connection;
  private readonly acl: Model<DatasetAclDoc>;
  private readonly datasets: Model<DatasetDoc>;

  constructor(connection: Connection) {
    this.connection = connection;
    this.acl =
      (connection.models.DatasetAcl as Model<DatasetAclDoc>) ??
      connection.model<DatasetAclDoc>('DatasetAcl', DatasetAclSchema);
    this.datasets =
      (connection.models.Dataset as Model<DatasetDoc>) ??
      connection.model<DatasetDoc>('Dataset', DatasetSchema);
  }

  private teamId(context: RequestContext): Types.ObjectId {
    return toOid(context.tenant.teamId, 'teamId', context.requestId);
  }

  private async requireDataset(
    datasetId: string,
    context: RequestContext,
  ): Promise<DatasetDoc & { _id: Types.ObjectId }> {
    const doc: (DatasetDoc & { _id: Types.ObjectId }) | null = await this.datasets
      .findOne({
        _id: toOid(datasetId, 'datasetId', context.requestId),
        teamId: this.teamId(context),
        deleteTime: null,
      })
      .lean();
    if (!doc) {
      throw new ApiErrorException(
        createApiError({
          code: 501070,
          requestId: context.requestId,
          params: { resourceType: 'dataset', resourceId: datasetId },
        }),
      );
    }
    return doc;
  }

  private async rows(
    datasetId: Types.ObjectId,
    teamId: Types.ObjectId,
  ): Promise<(DatasetAclDoc & { _id: Types.ObjectId })[]> {
    return this.acl
      .find({ teamId, resourceType: 'dataset', resourceId: datasetId })
      .lean<(DatasetAclDoc & { _id: Types.ObjectId })[]>();
  }

  private async collectInheritedMask(
    dataset: DatasetDoc & { _id: Types.ObjectId },
    teamId: Types.ObjectId,
    tmbId: string,
  ): Promise<number> {
    if (!dataset.inheritPermission) return 0;
    const masks: number[] = [];
    const parentIds: Types.ObjectId[] = [];
    let parentId = dataset.parentId;
    while (parentId) {
      parentIds.push(parentId);
      const parent: Pick<DatasetDoc, 'parentId'> | null = await this.datasets
        .findOne({ _id: parentId, teamId, deleteTime: null })
        .select({ parentId: 1 })
        .lean();
      parentId = parent?.parentId ?? null;
    }
    const collaboratorIds: (string | Types.ObjectId)[] = [tmbId];
    if (Types.ObjectId.isValid(tmbId)) collaboratorIds.push(new Types.ObjectId(tmbId));
    const inheritedRows = await this.acl.find({
      teamId,
      resourceType: 'dataset',
      resourceId: { $in: [dataset._id, ...parentIds] },
      inheritEnabled: true,
      $or: [
        { collaboratorType: 'member', collaboratorId: { $in: collaboratorIds } },
        { collaboratorType: 'group', collaboratorId: { $in: [...collaboratorIds, '*'] } },
        { collaboratorType: 'org', collaboratorId: { $in: [...collaboratorIds, '*'] } },
      ],
    });
    for (const row of inheritedRows) {
      if (
        row.collaboratorType === 'member' &&
        String(row.collaboratorId) === tmbId &&
        String(row.resourceId) === String(dataset._id)
      ) {
        continue;
      }
      masks.push(row.permissionMask);
    }
    return mergePermissionMasks(...masks);
  }

  private async snapshot(
    datasetId: string,
    context: RequestContext,
  ): Promise<PermissionSnapshotValue> {
    const teamId = this.teamId(context);
    const dataset = await this.requireDataset(datasetId, context);
    const rows = await this.rows(dataset._id, teamId);
    const ownerRow = rows.find((row) => row.collaboratorType === 'owner');
    const owner = ownerRow ? String(ownerRow.collaboratorId) : String(dataset.createdBy);
    const tmbId = context.tenant.tmbId;
    const memberRow = rows.find(
      (row) => row.collaboratorType === 'member' && String(row.collaboratorId) === tmbId,
    );
    const isOwner = String(dataset.createdBy) === tmbId || String(owner) === tmbId;
    const inheritedMask = await this.collectInheritedMask(dataset, teamId, tmbId);
    const explicitMask = memberRow ? memberRow.permissionMask : null;
    const permissionMask = evaluatePermissionMask({
      inheritedMask,
      explicitMask,
      isOwner,
      isRoot: context.tenant.isRoot,
    });
    return {
      owner,
      permissionMask,
      inherited: explicitMask === null,
      version: dataset.version,
      source: ownerRow?.source ?? 'local',
      collaboratorSummary: rows.map((row) => ({
        collaboratorType: row.collaboratorType,
        collaboratorId: String(row.collaboratorId),
        permissionMask: row.permissionMask,
      })),
    };
  }

  getPermission(
    input: { datasetId: string; options: { timeoutMs: number } },
    context: RequestContext,
  ): Promise<PermissionSnapshotValue> {
    return this.snapshot(input.datasetId, context);
  }

  async resumeInherit(
    input: { datasetId: string; version: number; options: { timeoutMs: number } },
    context: RequestContext,
  ): Promise<PermissionSnapshotValue> {
    const teamId = this.teamId(context);
    const datasetId = toOid(input.datasetId, 'datasetId', context.requestId);
    const updated = await this.datasets.findOneAndUpdate(
      { _id: datasetId, teamId, deleteTime: null, version: input.version },
      { $set: { inheritPermission: true, updateTime: new Date() }, $inc: { version: 1 } },
      { new: true },
    );
    if (!updated) {
      const current = await this.datasets.findOne({ _id: datasetId, teamId }).lean();
      if (!current) {
        throw new ApiErrorException(
          createApiError({
            code: 501070,
            requestId: context.requestId,
            params: { resourceType: 'dataset', resourceId: input.datasetId },
          }),
        );
      }
      throw versionConflict(input.datasetId, input.version, current.version, context.requestId);
    }
    await this.acl.updateMany(
      { teamId, resourceType: 'dataset', resourceId: datasetId },
      { $set: { inheritEnabled: true, updateTime: new Date() } },
    );
    return this.snapshot(input.datasetId, context);
  }

  async updateCollaborators(
    input: {
      datasetId: string;
      expectedVersion: number;
      collaborators: CollaboratorPermission[];
      options: { timeoutMs: number };
    },
    context: RequestContext,
  ): Promise<PermissionSnapshotValue> {
    const teamId = this.teamId(context);
    let attempt = 0;
    while (attempt < 3) {
      attempt += 1;
      const dataset = await this.requireDataset(input.datasetId, context);
      if (dataset.version !== input.expectedVersion) {
        throw versionConflict(
          input.datasetId,
          input.expectedVersion,
          dataset.version,
          context.requestId,
        );
      }
      const currentRows = await this.rows(dataset._id, teamId);
      const currentOwners = currentRows
        .filter((row) => row.collaboratorType === 'owner')
        .map((row) => ({
          collaboratorType: 'owner' as const,
          collaboratorId: String(row.collaboratorId),
          permissionMask: row.permissionMask,
        }));
      if (currentOwners.length === 0) {
        currentOwners.push({
          collaboratorType: 'owner',
          collaboratorId: String(dataset.createdBy),
          permissionMask: ACL_PERMISSION_ALL,
        });
      }
      if (canRemoveLastOwner(currentOwners, input.collaborators)) {
        throw new ApiErrorException(
          createApiError({
            code: 501008,
            requestId: context.requestId,
            params: {
              datasetId: input.datasetId,
              ownerTmbId: currentOwners[0]?.collaboratorId ?? String(dataset.createdBy),
            },
          }),
        );
      }
      const updated = await this.datasets.findOneAndUpdate(
        { _id: dataset._id, teamId, version: input.expectedVersion },
        { $set: { updateTime: new Date() }, $inc: { version: 1 } },
        { new: true },
      );
      if (!updated) continue;
      const now = new Date();
      for (const collaborator of input.collaborators) {
        await this.acl.findOneAndUpdate(
          {
            teamId,
            resourceType: 'dataset',
            resourceId: dataset._id,
            collaboratorType: collaborator.collaboratorType,
            collaboratorId: collaborator.collaboratorId,
          },
          {
            $set: {
              permission: collaborator.permissionMask,
              permissionMask: collaborator.permissionMask,
              inheritEnabled: true,
              source: 'local',
              updateTime: now,
            },
            $setOnInsert: {
              teamId,
              resourceType: 'dataset',
              resourceId: dataset._id,
              collaboratorType: collaborator.collaboratorType,
              collaboratorId: collaborator.collaboratorId,
              version: 1,
              createTime: now,
            },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        );
      }
      return this.snapshot(input.datasetId, context);
    }
    throw versionConflict(input.datasetId, input.expectedVersion, -1, context.requestId);
  }

  async deleteResourceAcl(
    input: { datasetId: string; deleteDataset?: boolean },
    context: RequestContext,
  ): Promise<{ deleted: number }> {
    const teamId = this.teamId(context);
    const datasetId = toOid(input.datasetId, 'datasetId', context.requestId);
    return withMongoTransaction(this.connection, async (session) => {
      const result = await this.acl.deleteMany(
        { teamId, resourceType: 'dataset', resourceId: datasetId },
        { session },
      );
      if (input.deleteDataset) {
        await this.datasets.deleteOne({ _id: datasetId, teamId }, { session });
      }
      return { deleted: result.deletedCount };
    });
  }
}

export function isFullPermission(mask: number): boolean {
  return mask === ACL_PERMISSION_ALL;
}
