import { ApiErrorException, createApiError, createInternalError } from '@kb/contracts';
import { Types, type Connection, type Model } from 'mongoose';
import type { PermissionSnapshotValue } from '../../../ports/capabilities';
import type { PortCallOptions, RequestContext } from '../../../ports/types';
import {
  DatasetAclSchema,
  DatasetSchema,
  type DatasetAclDoc,
  type DatasetDoc,
} from '../../../shared/persistence/schemas';
import { withMongoTransaction } from '../../../shared/persistence/with-mongo-transaction';
import type { OwnerTransferStore } from '../application/owner-transfer.service';
import { MongoDatasetAclRepository } from '../repository/mongo-dataset-acl.repository';

export interface OwnerTransferAdapterDeps {
  connection: Connection;
}

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

/**
 * D7-A（AB §3.1 清单第 25 条）：TransferDatasetOwnerPort 的 Mongo 事务实现。
 * 旧 Owner 行替换 + 目标 Owner 行写入 + datasets.version CAS，事务原子性保证不产生无 Owner 状态。
 */
export class OwnerTransferAdapter implements OwnerTransferStore {
  private readonly connection: Connection;
  private readonly repository: MongoDatasetAclRepository;
  private readonly acl: Model<DatasetAclDoc>;
  private readonly datasets: Model<DatasetDoc>;

  constructor(deps: OwnerTransferAdapterDeps) {
    this.connection = deps.connection;
    this.repository = new MongoDatasetAclRepository(deps.connection);
    this.acl =
      (deps.connection.models.DatasetAcl as Model<DatasetAclDoc> | undefined) ??
      deps.connection.model<DatasetAclDoc>('DatasetAcl', DatasetAclSchema);
    this.datasets =
      (deps.connection.models.Dataset as Model<DatasetDoc> | undefined) ??
      deps.connection.model<DatasetDoc>('Dataset', DatasetSchema);
  }

  async transfer(
    input: { datasetId: string; targetTmbId: string; transferId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ before: PermissionSnapshotValue; after: PermissionSnapshotValue }> {
    const before = await this.repository.getPermission(
      { datasetId: input.datasetId, options: input.options },
      context,
    );
    const teamId = toOid(context.tenant.teamId, 'teamId', context.requestId);
    const datasetId = toOid(input.datasetId, 'datasetId', context.requestId);
    const targetOid = toOid(input.targetTmbId, 'targetTmbId', context.requestId);

    try {
      await withMongoTransaction(this.connection, async (session) => {
        const dataset: (DatasetDoc & { _id: Types.ObjectId }) | null = await this.datasets
          .findOne({ _id: datasetId, teamId, deleteTime: null }, null, { session })
          .lean();
        if (!dataset) {
          throw new ApiErrorException(
            createApiError({
              code: 501070,
              requestId: context.requestId,
              params: { resourceType: 'dataset', resourceId: input.datasetId },
            }),
          );
        }
        if (dataset.version !== before.version) {
          throw new ApiErrorException(
            createApiError({
              code: 501047,
              requestId: context.requestId,
              params: { datasetId: input.datasetId, expectedVersion: before.version },
            }),
          );
        }
        const now = new Date();
        await this.acl.deleteMany(
          {
            teamId,
            resourceType: 'dataset',
            resourceId: datasetId,
            collaboratorType: 'owner',
            collaboratorId: { $ne: targetOid },
          },
          { session },
        );
        await this.acl.findOneAndUpdate(
          {
            teamId,
            resourceType: 'dataset',
            resourceId: datasetId,
            collaboratorType: 'owner',
            collaboratorId: targetOid,
          },
          {
            $set: {
              permission: 15,
              permissionMask: 15,
              inheritEnabled: true,
              source: 'owner-transfer',
              updateTime: now,
            },
            $setOnInsert: {
              teamId,
              resourceType: 'dataset',
              resourceId: datasetId,
              collaboratorType: 'owner',
              collaboratorId: targetOid,
              version: 1,
              createTime: now,
            },
          },
          { upsert: true, new: true, session },
        );
        const updated = await this.datasets.findOneAndUpdate(
          { _id: datasetId, teamId, version: before.version },
          { $inc: { version: 1 }, $set: { updateTime: now } },
          { new: true, session },
        );
        if (!updated) {
          throw new ApiErrorException(
            createApiError({
              code: 501047,
              requestId: context.requestId,
              params: { datasetId: input.datasetId, expectedVersion: before.version },
            }),
          );
        }
      });
    } catch (error) {
      if (error instanceof ApiErrorException) throw error;
      throw new ApiErrorException(
        createApiError({
          code: 501016,
          requestId: context.requestId,
          params: { store: 'mongo', operation: 'owner-transfer' },
        }),
      );
    }

    const after = await this.repository.getPermission(
      { datasetId: input.datasetId, options: input.options },
      context,
    );
    if (after.owner !== input.targetTmbId) {
      throw new ApiErrorException(
        createInternalError('owner-transfer.invariant', context.requestId),
      );
    }
    return { before, after };
  }
}

export function createOwnerTransferAdapter(deps: OwnerTransferAdapterDeps): OwnerTransferAdapter {
  return new OwnerTransferAdapter(deps);
}
