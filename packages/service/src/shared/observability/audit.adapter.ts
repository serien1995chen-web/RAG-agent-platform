import { ApiErrorException, createApiError } from '@kb/contracts';
import { createHash } from 'node:crypto';
import { Types, type Connection, type Model } from 'mongoose';
import type { AuditPort, AuditRecord } from '../../ports/capabilities';
import type { RequestContext } from '../../ports/types';
import { OperationLogSchema, type OperationLogDoc } from '../persistence/schemas';

/**
 * 设计 9.15 / 10.15 / 15.4：AuditPort 适配器（唯一写入入口）。
 * 同 teamId + eventId 幂等（确定性 _id），写入失败包装 501028，不阻塞业务调用方。
 */
export interface AuditAdapterDeps {
  connection: Connection;
}

export class AuditAdapter implements AuditPort {
  private readonly model: Model<OperationLogDoc>;

  constructor(connection: Connection) {
    this.model =
      (connection.models.OperationLog as Model<OperationLogDoc> | undefined) ??
      connection.model<OperationLogDoc>('OperationLog', OperationLogSchema);
  }

  async append(record: AuditRecord, context: RequestContext): Promise<{ auditId: string }> {
    const teamId = context.tenant.isRoot ? record.teamId : context.tenant.teamId;
    if (!context.tenant.isRoot && record.teamId !== context.tenant.teamId) {
      throw new ApiErrorException(
        createApiError({
          code: 501070,
          requestId: context.requestId,
          params: { resourceType: record.resourceType, resourceId: record.resourceId },
        }),
      );
    }
    try {
      const auditId = new Types.ObjectId(
        createHash('sha256').update(`${teamId}:${record.eventId}`).digest('hex').slice(0, 24),
      );
      const doc = await this.model.findOneAndUpdate(
        { _id: auditId },
        {
          $setOnInsert: {
            teamId: new Types.ObjectId(teamId),
            tmbId: new Types.ObjectId(record.actorTmbId),
            timestamp: new Date(),
            event: record.operation,
            metadata: { eventId: record.eventId, payload: record.payload ?? null },
            requestId: record.requestId,
            operation: record.operation,
            resourceType: record.resourceType,
            resourceId: record.resourceId,
            result: null,
            beforeHash: null,
            afterHash: null,
            params: null,
          },
        },
        { upsert: true, new: true },
      );
      return { auditId: String(doc?._id ?? auditId) };
    } catch {
      throw new ApiErrorException(
        createApiError({
          code: 501028,
          requestId: context.requestId,
          params: { operation: 'append' },
        }),
      );
    }
  }
}

export function createAuditAdapter(deps: AuditAdapterDeps): AuditAdapter {
  return new AuditAdapter(deps.connection);
}
