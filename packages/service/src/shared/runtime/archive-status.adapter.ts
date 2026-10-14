import { ApiErrorException, createApiError } from '@kb/contracts';
import { Types } from 'mongoose';
import type { ArchiveStatusPort } from '../../ports/capabilities';
import type { PortCallOptions, RequestContext } from '../../ports/types';

/**
 * 设计 20.1 / D2：归档状态 Port 首期空实现语义。
 * 固定返回 `archived_not_supported`，不猜测、不回退、不访问 DB、不新增 archiveTime / archiveBucket 字段与端点。
 */
export class ArchiveStatusAdapter implements ArchiveStatusPort {
  async status(
    input: { datasetId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ archived: boolean; state?: string }> {
    if (
      !Types.ObjectId.isValid(input.datasetId) ||
      !Types.ObjectId.isValid(context.tenant.teamId)
    ) {
      throw new ApiErrorException(
        createApiError({
          code: 501070,
          requestId: context.requestId,
          params: { resourceType: 'dataset', resourceId: input.datasetId },
        }),
      );
    }
    return { archived: false, state: 'archived_not_supported' };
  }
}

export function createArchiveStatusAdapter(): ArchiveStatusAdapter {
  return new ArchiveStatusAdapter();
}
