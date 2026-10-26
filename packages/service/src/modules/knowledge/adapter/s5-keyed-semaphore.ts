interface KeyState {
  active: number;
  queue: Array<() => void>;
}

export class S5KeyedSemaphore {
  private readonly states = new Map<string, KeyState>();

  constructor(private readonly limitPerKey: number) {
    if (!Number.isInteger(limitPerKey) || limitPerKey < 1) {
      throw new RangeError('semaphore limit must be a positive integer');
    }
  }

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const state = this.states.get(key) ?? { active: 0, queue: [] };
    this.states.set(key, state);
    if (state.active >= this.limitPerKey) {
      await new Promise<void>((resolve) => state.queue.push(resolve));
    }
    state.active += 1;
    try {
      return await work();
    } finally {
      state.active -= 1;
      const next = state.queue.shift();
      if (next) next();
      else if (state.active === 0) this.states.delete(key);
    }
  }
}
