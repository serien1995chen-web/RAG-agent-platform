import { describe, expect, it, vi } from 'vitest';
import { createSingleFlight } from '../../src/query/use-knowledge-mutation';

describe('knowledge mutation single-flight lock', () => {
  it('deduplicates immediate submissions until the first request settles', async () => {
    let resolveRequest: ((value: string) => void) | undefined;
    const request = new Promise<string>((resolve) => {
      resolveRequest = resolve;
    });
    const start = vi.fn(() => request);
    const singleFlight = createSingleFlight<string>();

    const first = singleFlight.run(start);
    const second = singleFlight.run(() => Promise.resolve('unexpected'));

    expect(start).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);

    resolveRequest?.('created');
    await expect(Promise.all([first, second])).resolves.toEqual(['created', 'created']);

    await expect(singleFlight.run(() => Promise.resolve('created-again'))).resolves.toBe(
      'created-again',
    );
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('unlocks submission after a rejected request', async () => {
    const singleFlight = createSingleFlight<string>();
    await expect(singleFlight.run(() => Promise.reject(new Error('offline')))).rejects.toThrow(
      'offline',
    );
    await expect(singleFlight.run(() => Promise.resolve('created'))).resolves.toBe('created');
  });
});
