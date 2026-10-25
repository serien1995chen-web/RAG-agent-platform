'use client';

import { useQuery, type QueryKey, type UseQueryResult } from '@tanstack/react-query';
import { knowledgeRequest } from '../client/knowledge-client';

export function useKnowledgeQuery<T>(key: QueryKey, path: string | null): UseQueryResult<T> {
  return useQuery<T>({
    queryKey: key,
    queryFn: () => knowledgeRequest<T>(path as string),
    enabled: path !== null,
  });
}
