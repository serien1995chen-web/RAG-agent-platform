'use client';

import { useQueries, useQuery, type QueryKey, type UseQueryResult } from '@tanstack/react-query';
import { knowledgeRequest } from '../client/knowledge-client';

export function useKnowledgeQuery<T>(key: QueryKey, path: string | null): UseQueryResult<T> {
  return useQuery<T>({
    queryKey: key,
    queryFn: () => knowledgeRequest<T>(path as string),
    enabled: path !== null,
  });
}

export function useKnowledgeQueries<T>(
  entries: readonly { key: QueryKey; path: string | null }[],
): UseQueryResult<T>[] {
  return useQueries({
    queries: entries.map((entry) => ({
      queryKey: entry.key,
      queryFn: () => knowledgeRequest<T>(entry.path as string),
      enabled: entry.path !== null,
    })),
  });
}
