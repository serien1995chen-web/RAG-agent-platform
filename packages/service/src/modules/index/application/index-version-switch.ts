import { ApiErrorException, createApiError } from '@kb/contracts';
import type { PortCallOptions, RequestContext } from '../../../ports/types';

export interface DatasetIndexVersionStore {
  switchIndexVersion(
    input: {
      datasetId: string;
      expectedVersion: number;
      expectedIndexVersion: string;
      nextIndexVersion: string;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{ version: number }>;
}

export class IndexVersionSwitchService {
  constructor(private readonly deps: { store: DatasetIndexVersionStore }) {}

  switchIndexVersion(
    input: {
      datasetId: string;
      expectedVersion: number;
      expectedIndexVersion: string;
      nextIndexVersion: string;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{ version: number }> {
    if (!input.expectedIndexVersion || !input.nextIndexVersion) {
      throw new ApiErrorException(
        createApiError({
          code: 501013,
          requestId: context.requestId,
          params: {
            field: 'indexVersion',
            value: input.nextIndexVersion,
            rangeOrVersion: 'non-empty',
          },
        }),
      );
    }
    if (input.expectedIndexVersion === input.nextIndexVersion) {
      throw new ApiErrorException(
        createApiError({
          code: 501013,
          requestId: context.requestId,
          params: {
            field: 'indexVersion',
            value: input.nextIndexVersion,
            rangeOrVersion: 'different',
          },
        }),
      );
    }
    return this.deps.store.switchIndexVersion(input, context);
  }
}
