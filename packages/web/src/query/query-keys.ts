import type { QueryKey } from '@tanstack/react-query';

type QueryParams = Record<string, string | number | boolean | null | undefined>;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

function stableParams(params: QueryParams = {}): QueryParams {
  return stableValue(params) as QueryParams;
}

const VERSION = 'v1' as const;

export const knowledgeQueryKeys = {
  all: ['knowledge', VERSION] as const,
  spaces: {
    all: ['knowledge', VERSION, 'spaces'] as QueryKey,
    list: (params: QueryParams = { limit: 200 }): QueryKey => [
      'knowledge',
      VERSION,
      'spaces',
      'list',
      stableParams(params),
    ],
    detail: (spaceId: string): QueryKey => ['knowledge', VERSION, 'spaces', 'detail', spaceId],
  },
  directories: {
    list: (spaceId: string, params: QueryParams = { limit: 200 }): QueryKey => [
      'knowledge',
      VERSION,
      'spaces',
      spaceId,
      'directories',
      'list',
      stableParams(params),
    ],
  },
  sources: {
    list: (spaceId: string, params: QueryParams = { limit: 200 }): QueryKey => [
      'knowledge',
      VERSION,
      'spaces',
      spaceId,
      'sources',
      'list',
      stableParams(params),
    ],
    detail: (sourceId: string): QueryKey => ['knowledge', VERSION, 'sources', 'detail', sourceId],
    preview: (sourceId: string): QueryKey => ['knowledge', VERSION, 'sources', 'preview', sourceId],
    segments: (sourceId: string, params: QueryParams = { limit: 200, sort: 'order' }): QueryKey => [
      'knowledge',
      VERSION,
      'sources',
      sourceId,
      'segments',
      stableParams(params),
    ],
  },
  tags: {
    list: (spaceId: string, params: QueryParams = { limit: 200 }): QueryKey => [
      'knowledge',
      VERSION,
      'spaces',
      spaceId,
      'tags',
      'list',
      stableParams(params),
    ],
  },
  collaborators: {
    list: (spaceId: string, params: QueryParams = { limit: 200 }): QueryKey => [
      'knowledge',
      VERSION,
      'spaces',
      spaceId,
      'collaborators',
      stableParams(params),
    ],
  },
  acl: (resourceType: 'space' | 'directory' | 'source', resourceId: string): QueryKey => [
    'knowledge',
    VERSION,
    'acl',
    resourceType,
    resourceId,
  ],
  jobs: {
    detail: (jobId: string): QueryKey => ['knowledge', VERSION, 'jobs', 'detail', jobId],
    list: (params: QueryParams = { limit: 200 }): QueryKey => [
      'knowledge',
      VERSION,
      'jobs',
      'list',
      stableParams(params),
    ],
  },
  uploads: {
    detail: (uploadId: string): QueryKey => ['knowledge', VERSION, 'uploads', 'detail', uploadId],
  },
  archive: {
    list: (spaceId: string): QueryKey => [
      'knowledge',
      VERSION,
      'spaces',
      spaceId,
      'archive',
      'list',
    ],
  },
  operations: {
    status: ['knowledge', VERSION, 'operations', 'status'] as QueryKey,
  },
};
