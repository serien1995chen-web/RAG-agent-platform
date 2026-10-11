import { describe, expect, it } from 'vitest';
import { ConcurrencyLimiterError, createLimiter, mapWithConcurrency } from '../../src/index';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('TEST-PARSE-CONCURRENCY-001 self-built limiter (U-18)', () => {
  it('never exceeds the configured concurrency and reports counts', async () => {
    const limiter = createLimiter({ concurrency: 2 });
    let peak = 0;
    const gates = [deferred(), deferred(), deferred()];
    const tasks = gates.map((gate) =>
      limiter(async () => {
        peak = Math.max(peak, limiter.activeCount);
        await gate.promise;
      }),
    );
    await Promise.resolve();
    expect(limiter.activeCount).toBe(2);
    expect(limiter.pendingCount).toBe(1);
    gates.forEach((gate) => gate.resolve());
    await Promise.all(tasks);
    expect(peak).toBeLessThanOrEqual(2);
    expect(limiter.activeCount).toBe(0);
    expect(limiter.pendingCount).toBe(0);
  });

  it('produces order-independent results with mapWithConcurrency', async () => {
    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => value * 10);
    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  it('propagates task rejections and still frees slots', async () => {
    const limiter = createLimiter({ concurrency: 1 });
    await expect(
      limiter(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(limiter.activeCount).toBe(0);
    expect(await limiter(async () => 'ok')).toBe('ok');
  });

  it('rejects invalid concurrency', () => {
    expect(() => createLimiter({ concurrency: 0 })).toThrow(ConcurrencyLimiterError);
  });
});
