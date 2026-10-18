import { useCallback, useEffect, useRef, useState } from 'react';

export interface KbResource<T> {
  data: T | null;
  loading: boolean;
  error: unknown;
  reload: () => void;
}

/** key 变化即重新请求；请求序号防止旧响应覆盖新状态。 */
export function useKbResource<T>(key: string, loader: () => Promise<T>): KbResource<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  const sequence = useRef(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    const current = ++sequence.current;
    setLoading(true);
    setError(null);
    loaderRef
      .current()
      .then((value) => {
        if (current !== sequence.current) return;
        setData(value);
        setLoading(false);
      })
      .catch((caught: unknown) => {
        if (current !== sequence.current) return;
        setError(caught);
        setLoading(false);
      });
  }, [key, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { data, loading, error, reload };
}
