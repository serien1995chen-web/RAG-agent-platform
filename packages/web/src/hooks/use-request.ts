import { useCallback, useEffect, useState } from 'react';
import type { ApiResponse } from '@kb/contracts';

export type ApiEnvelope<T> = ApiResponse<T>;

export async function fetchApi<T>(input: string, init?: RequestInit): Promise<ApiEnvelope<T>> {
  const response = await fetch(input, {
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  return (await response.json()) as ApiEnvelope<T>;
}

export interface UseRequestResult<T> {
  data: T | null;
  envelope: ApiEnvelope<T> | null;
  loading: boolean;
  error: ApiEnvelope<unknown> | null;
  reload: () => Promise<void>;
}

export function useRequest<T>(loader: () => Promise<ApiEnvelope<T>>): UseRequestResult<T> {
  const [envelope, setEnvelope] = useState<ApiEnvelope<T> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiEnvelope<unknown> | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    try {
      const result = await loader();
      if (result.code !== 200) {
        setError(result as unknown as ApiEnvelope<unknown>);
        setEnvelope(null);
      } else {
        setEnvelope(result);
        setError(null);
      }
    } catch {
      setError(null);
      setEnvelope(null);
    } finally {
      setLoading(false);
    }
  }, [loader]);

  useEffect(() => {
    void run();
  }, [run]);

  return { data: envelope?.data ?? null, envelope, loading, error, reload: run };
}
