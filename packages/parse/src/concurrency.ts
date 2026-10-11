/**
 * @kb/parse 自研并发限制器（U-18 / 设计文档 9.8.1）。
 * 保持 p-limit 7.x 的最小可判定语义：limit(n) + 队列 + activeCount/pendingCount 可观测。
 * 禁止引入 p-limit 运行时依赖。
 */

export interface ConcurrencyLimiter {
  <T>(fn: () => Promise<T> | T): Promise<T>;
  readonly activeCount: number;
  readonly pendingCount: number;
  clearQueue(): void;
}

export interface ConcurrencyLimiterOptions {
  /** 允许同时运行的任务上限，必须为正整数。 */
  concurrency: number;
}

export class ConcurrencyLimiterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConcurrencyLimiterError';
  }
}

function assertConcurrency(value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new ConcurrencyLimiterError(`concurrency must be a positive integer, received ${value}`);
  }
}

/** 创建并发限制器；任务按入队顺序 FIFO 调度。 */
export function createLimiter(options: ConcurrencyLimiterOptions): ConcurrencyLimiter {
  assertConcurrency(options.concurrency);

  let active = 0;
  const queue: Array<() => void> = [];

  const drain = (): void => {
    while (active < options.concurrency && queue.length > 0) {
      const next = queue.shift();
      if (next) next();
    }
  };

  const run = <T>(fn: () => Promise<T> | T): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const start = (): void => {
        active += 1;
        let result: Promise<T> | T;
        try {
          result = fn();
        } catch (error) {
          active -= 1;
          reject(error);
          drain();
          return;
        }
        Promise.resolve(result).then(
          (value) => {
            active -= 1;
            resolve(value);
            drain();
          },
          (error: unknown) => {
            active -= 1;
            reject(error);
            drain();
          },
        );
      };

      if (active < options.concurrency) {
        start();
      } else {
        queue.push(start);
      }
    });

  const limiter = run as ConcurrencyLimiter;
  Object.defineProperties(limiter, {
    activeCount: { get: () => active },
    pendingCount: { get: () => queue.length },
  });
  limiter.clearQueue = (): void => {
    queue.splice(0, queue.length);
  };
  return limiter;
}

/** 便捷包装：以固定并发度并行处理输入，返回与输入同序的结果。 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R> | R,
): Promise<R[]> {
  const limiter = createLimiter({ concurrency });
  return Promise.all(items.map((item, index) => limiter(() => mapper(item, index))));
}
