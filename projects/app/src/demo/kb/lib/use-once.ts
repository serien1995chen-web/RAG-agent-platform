import { useEffect, useRef } from 'react';

/**
 * 仅执行一次的 effect：React StrictMode 在开发态会重复调用 effect，
 * 用它避免同一次挂载产生重复请求（不影响真实失败）。
 */
export function useOnce(run: () => void): void {
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    run();
  }, []); // 只在首次挂载执行；StrictMode 的二次调用由 done 挡住
}
