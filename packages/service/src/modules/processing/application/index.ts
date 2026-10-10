import { ApiErrorException, createApiError } from '@kb/contracts';
import type { RequestContext } from '../../../ports/types';
import type { ProcessingJobRepository } from '../../../ports/repositories';
import type { PortCallOptions } from '../../../ports/types';
import type { ProcessingJobSnapshot } from '../../../ports/types';

const PROCESSING_LEASE_TOKEN = Symbol('processingLeaseToken');

interface ProcessingLeaseToken {
  taskId: string;
  lockTime: string;
}

export interface ProcessingTaskErrorView {
  messageKey: string;
  retryable: 'retryable' | 'no-retry' | 'manual';
  category: 'provider' | 'storage' | 'task' | 'unknown';
}

export interface ProcessingTaskView {
  taskId: string;
  jobId: string;
  datasetId: string;
  collectionId: string | null;
  dataId: string | null;
  mode: string;
  retryCount: number;
  lockTime: string;
  weight: number;
  derivedState: string;
  error: ProcessingTaskErrorView | null;
}

export interface ProcessingTaskErrorPage {
  total: number;
  list: ProcessingTaskView[];
  cursor: string | null;
}

export interface ProcessingQueueModeStats {
  mode: string;
  depth: number;
  running: number;
}

interface ProcessingLeaseAwareRepository {
  finishWithLease(
    input: {
      taskId: string;
      lockTime: string;
      state: 'success' | 'failed' | 'blocked' | 'final_error';
      errorMsg?: string;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<void>;
  resumeTask(
    input: { taskId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ taskId: string; retryCount: number }>;
  getTaskDetail(
    input: { taskId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ task: ProcessingTaskView; derivedState: string }>;
  listTaskErrors(
    input: {
      taskId?: string;
      collectionId?: string;
      datasetId?: string;
      cursor?: string;
      limit: number;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<ProcessingTaskErrorPage>;
  getQueueStats(
    input: { datasetId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<ProcessingQueueModeStats[]>;
  updateTrainingData(
    input: {
      dataId?: string;
      collectionId?: string;
      datasetId?: string;
      mode: string;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{ acceptedCount: number }>;
  deleteTrainingData(
    input: { collectionId?: string; dataId?: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ deletedCount: number }>;
  listCollectionErrors(
    input: { collectionId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<ProcessingTaskView[]>;
  hasError(
    input: { datasetId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<boolean>;
}

type ProcessingContext = RequestContext & {
  [PROCESSING_LEASE_TOKEN]?: ProcessingLeaseToken;
};

function hasLeaseCapabilities(
  repository: ProcessingJobRepository,
): repository is ProcessingJobRepository & ProcessingLeaseAwareRepository {
  const candidate = repository as Partial<ProcessingLeaseAwareRepository>;
  return (
    typeof candidate.finishWithLease === 'function' &&
    typeof candidate.resumeTask === 'function' &&
    typeof candidate.getTaskDetail === 'function' &&
    typeof candidate.listTaskErrors === 'function' &&
    typeof candidate.getQueueStats === 'function' &&
    typeof candidate.updateTrainingData === 'function' &&
    typeof candidate.deleteTrainingData === 'function' &&
    typeof candidate.listCollectionErrors === 'function' &&
    typeof candidate.hasError === 'function'
  );
}

function scopeInvalid(scope: string, allowed: string[], requestId: string): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code: 501048,
      requestId,
      params: { scope, allowed },
    }),
  );
}

export interface ProcessingServiceDeps {
  repository: ProcessingJobRepository;
}

/** ProcessingJob 应用编排骨架：只依赖 Port，不直接拼装存储查询。 */
export class ProcessingApplicationService {
  constructor(private readonly deps: ProcessingServiceDeps) {}

  enqueueJob(
    input: {
      job: Omit<ProcessingJobSnapshot, 'taskId' | 'retryCount' | 'lockTime'>;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{ taskId: string; jobId: string }> {
    return this.deps.repository.enqueue(input, context);
  }

  claimJob(
    input: { taskId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ taskId: string; lockTime: string }> {
    return this.deps.repository.claim(input, context).then((claimed) => {
      (context as ProcessingContext)[PROCESSING_LEASE_TOKEN] = {
        taskId: claimed.taskId,
        lockTime: claimed.lockTime,
      };
      return claimed;
    });
  }

  renewJob(
    input: { taskId: string; lockTime: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ lockTime: string }> {
    return this.deps.repository.renew(input, context).then((renewed) => {
      const processingContext = context as ProcessingContext;
      if (processingContext[PROCESSING_LEASE_TOKEN]?.taskId === input.taskId) {
        processingContext[PROCESSING_LEASE_TOKEN] = {
          taskId: input.taskId,
          lockTime: renewed.lockTime,
        };
      }
      return renewed;
    });
  }

  finishJob(
    input: {
      taskId: string;
      state: 'success' | 'failed' | 'blocked' | 'final_error';
      errorMsg?: string;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<void> {
    const processingContext = context as ProcessingContext;
    const token = processingContext[PROCESSING_LEASE_TOKEN];
    const repository = this.deps.repository;
    const finish =
      token?.taskId === input.taskId && hasLeaseCapabilities(repository)
        ? repository.finishWithLease(
            {
              taskId: input.taskId,
              lockTime: token.lockTime,
              state: input.state,
              ...(input.errorMsg !== undefined ? { errorMsg: input.errorMsg } : {}),
              options: input.options,
            },
            context,
          )
        : repository.finish(input, context);

    return finish.finally(() => {
      if (processingContext[PROCESSING_LEASE_TOKEN]?.taskId === input.taskId) {
        delete processingContext[PROCESSING_LEASE_TOKEN];
      }
    });
  }

  async resumeJob(
    input: { taskId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ taskId: string; retryCount: number }> {
    const repository = this.deps.repository;
    if (!hasLeaseCapabilities(repository)) {
      throw new ApiErrorException(
        createApiError({
          code: 501005,
          requestId: context.requestId,
          params: { taskId: input.taskId, from: 'final_error', to: 'resume' },
        }),
      );
    }
    return repository.resumeTask(input, context);
  }

  async getTaskDetail(
    input: { taskId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ task: ProcessingTaskView; derivedState: string }> {
    this.requireRead(context);
    return this.processingRepository(context).getTaskDetail(input, context);
  }

  async listTaskErrors(
    input: {
      taskId?: string;
      collectionId?: string;
      datasetId?: string;
      cursor?: string;
      limit: number;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<ProcessingTaskErrorPage> {
    this.requireRead(context);
    if (!input.taskId && !input.collectionId && !input.datasetId) {
      throw scopeInvalid('empty', ['taskId', 'collectionId', 'datasetId'], context.requestId);
    }
    return this.processingRepository(context).listTaskErrors(input, context);
  }

  async resumeTask(
    input: { taskId: string; reason: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ taskId: string; retryCount: number }> {
    this.requireWrite(context);
    return this.processingRepository(context).resumeTask(
      { taskId: input.taskId, options: input.options },
      context,
    );
  }

  async getQueueStats(
    input: { datasetId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<ProcessingQueueModeStats[]> {
    this.requireRead(context);
    return this.processingRepository(context).getQueueStats(input, context);
  }

  async updateTrainingData(
    input: {
      dataId?: string;
      collectionId?: string;
      datasetId?: string;
      mode: string;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{ acceptedCount: number }> {
    this.requireWrite(context);
    if (!input.dataId && !input.collectionId && !input.datasetId) {
      throw scopeInvalid('empty', ['dataId', 'collectionId', 'datasetId'], context.requestId);
    }
    return this.processingRepository(context).updateTrainingData(input, context);
  }

  async deleteTrainingData(
    input: { collectionId?: string; dataId?: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ deletedCount: number }> {
    this.requireManage(context);
    const scopes = [input.collectionId, input.dataId].filter((value) => Boolean(value));
    if (scopes.length !== 1) {
      throw scopeInvalid(
        scopes.length === 0 ? 'empty' : 'multiple',
        ['collectionId', 'dataId'],
        context.requestId,
      );
    }
    return this.processingRepository(context).deleteTrainingData(input, context);
  }

  async listCollectionErrors(
    input: { collectionId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<ProcessingTaskView[]> {
    this.requireRead(context);
    return this.processingRepository(context).listCollectionErrors(input, context);
  }

  async hasError(
    input: { datasetId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<boolean> {
    this.requireRead(context);
    return this.processingRepository(context).hasError(input, context);
  }

  private processingRepository(
    context: RequestContext,
  ): ProcessingJobRepository & ProcessingLeaseAwareRepository {
    const repository = this.deps.repository;
    if (!hasLeaseCapabilities(repository)) {
      throw new ApiErrorException(
        createApiError({
          code: 501005,
          requestId: context.requestId,
          params: { taskId: '', from: 'unavailable', to: 'processing_query' },
        }),
      );
    }
    return repository;
  }

  private requireRead(context: RequestContext): void {
    this.requirePermission(context, context.permission.canRead, 'read');
  }

  private requireWrite(context: RequestContext): void {
    this.requirePermission(context, context.permission.canWrite, 'write');
  }

  private requireManage(context: RequestContext): void {
    this.requirePermission(context, context.permission.canManage, 'manage');
  }

  private requirePermission(context: RequestContext, allowed: boolean, requiredRole: string): void {
    if (allowed) return;
    throw new ApiErrorException(
      createApiError({
        code: 501027,
        requestId: context.requestId,
        params: { requiredRole },
      }),
    );
  }
}
