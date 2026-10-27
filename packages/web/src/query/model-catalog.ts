'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { knowledgeRequest } from '../client/knowledge-client';
import type { S5ModelView } from '../components/s5-model-parse-state';
import { knowledgeQueryKeys } from './query-keys';

export interface ModelPageInfo {
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ModelCatalogPage {
  items: S5ModelView[];
  pageInfo: ModelPageInfo;
}

export async function loadCompleteModelCatalog(
  request: <T>(path: string) => Promise<T> = knowledgeRequest,
): Promise<{ items: S5ModelView[] }> {
  const items: S5ModelView[] = [];
  let cursor: string | null = null;
  const seenCursors = new Set<string>();
  do {
    const query = new URLSearchParams({ limit: '200' });
    if (cursor) query.set('cursor', cursor);
    const page = await request<ModelCatalogPage>(`/v1/knowledge/models?${query.toString()}`);
    items.push(...page.items);
    if (page.pageInfo.hasMore && !page.pageInfo.nextCursor) {
      throw new DOMException('model catalog pagination is missing nextCursor', 'DataError');
    }
    cursor = page.pageInfo.nextCursor;
    if (cursor) {
      if (seenCursors.has(cursor)) {
        throw new DOMException('model catalog pagination repeated nextCursor', 'DataError');
      }
      seenCursors.add(cursor);
    }
  } while (cursor);
  return { items };
}

export function useKnowledgeModelCatalog(): UseQueryResult<{ items: S5ModelView[] }> {
  return useQuery({
    queryKey: knowledgeQueryKeys.models.list(),
    queryFn: () => loadCompleteModelCatalog(),
  });
}
