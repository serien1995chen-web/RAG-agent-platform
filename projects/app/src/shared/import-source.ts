import { ApiErrorException, createApiError } from '@kb/contracts';
import {
  ImportSourceService,
  type CollectionSnapshot,
  type DatasetSourceProvider,
} from '@kb/service';
import { createSourceProviderRegistry } from '../../../../packages/service/src/modules/collection/adapter/source-provider/index';

export const MAX_RAW_TEXT_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES_PER_REQUEST = 10;
export const MAX_PUSH_ITEMS = 200;
export const PORT_OPTIONS = { timeoutMs: 10_000 } as const;

export function apiError(
  code: number,
  requestId: string,
  params: Record<string, unknown>,
): ApiErrorException {
  return new ApiErrorException(createApiError({ code, requestId, params }));
}

export function resolveSourceProvider(sourceType: string): DatasetSourceProvider {
  const registry = createSourceProviderRegistry({});
  const provider = registry.resolve(sourceType);
  if (!provider) {
    throw apiError(501017, 'source-provider', { provider: sourceType });
  }
  return provider;
}

export function normalizeTrainingType(mode: string | undefined): {
  mode: 'chunk' | 'qa' | 'image' | 'imageParse';
  autoIndexes: boolean;
} {
  if (mode === undefined || mode === 'auto') return { mode: 'chunk', autoIndexes: true };
  if (mode === 'image' || mode === 'imageParse' || mode === 'qa' || mode === 'chunk') {
    return { mode, autoIndexes: false };
  }
  return { mode: 'chunk', autoIndexes: false };
}

export type ImportRuntime = {
  collectionRepository: import('@kb/service').CollectionRepository;
  processingRepository: import('@kb/service').ProcessingJobRepository;
  ports: import('@kb/service').ServicePorts;
};

export function createImportSourceService(
  runtime: ImportRuntime,
  sourceProvider: DatasetSourceProvider,
): ImportSourceService {
  const queue = (runtime.ports as { queue?: import('@kb/dal').QueuePort }).queue;
  return new ImportSourceService({
    collections: runtime.collectionRepository,
    sourceProvider,
    trainingProcessor: runtime.ports.trainingProcessor,
    jobs: runtime.processingRepository,
    ...(queue ? { queue } : {}),
  });
}

export function sourceCollection(input: {
  teamId: string;
  datasetId: string;
  name: string;
  sourceRef: string;
  type?: string;
  parentId?: string | null;
}): Omit<CollectionSnapshot, 'collectionId' | 'version' | 'createTime' | 'updateTime'> {
  return {
    teamId: input.teamId,
    datasetId: input.datasetId,
    parentId: input.parentId ?? null,
    type: input.type ?? 'file',
    name: input.name,
    tagIds: [],
    sourceRef: input.sourceRef,
  };
}
