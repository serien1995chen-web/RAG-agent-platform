'use client';

import { useInfiniteQuery, type QueryKey } from '@tanstack/react-query';
import { knowledgeRequest } from '../client/knowledge-client';

export interface CursorPageInfo {
  nextCursor: string | null;
  hasMore: boolean;
}

export interface CursorPage<T> {
  items: T[];
  pageInfo: CursorPageInfo;
}

export interface CursorKnowledgeQueryOptions {
  key: QueryKey;
  path: string;
  enabled?: boolean;
  limit?: number;
  sort?: string;
  query?: Record<string, string | number | boolean | undefined>;
}

export function buildCursorPagePath(
  options: Pick<CursorKnowledgeQueryOptions, 'path' | 'limit' | 'sort' | 'query'>,
  cursor?: string,
): string {
  const separator = options.path.includes('?') ? '&' : '?';
  const params = new URLSearchParams({
    limit: String(options.limit ?? 50),
  });
  if (options.sort) params.set('sort', options.sort);
  if (cursor) params.set('cursor', cursor);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) params.set(key, String(value));
  }
  return `${options.path}${separator}${params.toString()}`;
}

export function useCursorKnowledgeQuery<T>(options: CursorKnowledgeQueryOptions) {
  return useInfiniteQuery<CursorPage<T>>({
    queryKey: [
      ...options.key,
      'cursor',
      {
        limit: options.limit ?? 50,
        sort: options.sort ?? null,
        query: options.query ?? null,
      },
    ],
    queryFn: ({ pageParam }) =>
      knowledgeRequest<CursorPage<T>>(buildCursorPagePath(options, pageParam)),
    getNextPageParam: (lastPage) =>
      lastPage.pageInfo.hasMore && lastPage.pageInfo.nextCursor
        ? lastPage.pageInfo.nextCursor
        : undefined,
    enabled: options.enabled ?? true,
  });
}
