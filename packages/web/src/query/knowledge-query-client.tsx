'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

export function createKnowledgeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        cacheTime: 5 * 60_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: 0,
      },
    },
  });
}

export function KnowledgeQueryProvider(props: { children: ReactNode; client?: QueryClient }) {
  const [client] = useState(() => props.client ?? createKnowledgeQueryClient());
  return <QueryClientProvider client={client}>{props.children}</QueryClientProvider>;
}
