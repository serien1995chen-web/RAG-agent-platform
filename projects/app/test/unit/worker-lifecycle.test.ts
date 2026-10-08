import { resolveRuntimeRole, type AppConfig } from '@kb/service';
import { describe, expect, it } from 'vitest';
import type { ExtendedAppRuntime } from '../../src/runtime/bootstrap';
import { createDrainCoordinator, type DrainPhase, type RuntimeUnit } from '../../src/runtime/drain';
import { startWorkerRuntime } from '../../src/runtime/worker';

function fakeConfig(mode: 'all' | 'http' | 'worker'): AppConfig {
  return {
    system: { appWorkerMode: mode },
    role: resolveRuntimeRole(mode),
  } as unknown as AppConfig;
}

function fakeRuntime(mode: 'all' | 'http' | 'worker'): ExtendedAppRuntime {
  return {
    config: fakeConfig(mode),
    clients: {
      logger: { log: () => undefined, child: () => undefined },
    },
  } as unknown as ExtendedAppRuntime;
}

function recordingUnit(
  name: string,
  phase: DrainPhase,
  events: string[],
  behavior: 'ok' | 'hang' = 'ok',
): RuntimeUnit {
  return {
    name,
    phase,
    async close() {
      if (behavior === 'hang') return new Promise<void>(() => undefined);
      events.push(name);
    },
  };
}

describe('runtime role matrix (设计 5.4 / 6.4)', () => {
  it('all/http/worker 角色按设计表解算', () => {
    expect(resolveRuntimeRole('all')).toEqual({
      mode: 'all',
      runsHttp: true,
      runsWorker: true,
      runsChangeStream: true,
      runsScheduler: true,
    });
    expect(resolveRuntimeRole('http')).toEqual({
      mode: 'http',
      runsHttp: true,
      runsWorker: false,
      runsChangeStream: true,
      runsScheduler: false,
    });
    expect(resolveRuntimeRole('worker')).toEqual({
      mode: 'worker',
      runsHttp: false,
      runsWorker: true,
      runsChangeStream: false,
      runsScheduler: true,
    });
  });
});

describe('drain coordinator (设计 5.5 / 6.5.1)', () => {
  it('四态可观测且 beginShutdown 幂等', async () => {
    const events: string[] = [];
    const drain = createDrainCoordinator({
      units: [recordingUnit('queue-workers', 'claims', events)],
    });
    expect(drain.getState()).toBe('starting');
    drain.markReady();
    expect(drain.getState()).toBe('ready');

    const first = drain.beginShutdown('test');
    const second = drain.beginShutdown('test');
    expect(first).toBe(second);
    const result = await first;
    expect(result).toEqual({ timedOut: false, remainingUnits: [] });
    expect(drain.getState()).toBe('closed');
    expect(events).toEqual(['queue-workers']);
  });

  it('关闭顺序固定为 停止领取 → 释放租约 → 释放 leader lock', async () => {
    const events: string[] = [];
    const drain = createDrainCoordinator({
      units: [
        recordingUnit('dataset-sync-scheduler', 'leader-lock', events),
        recordingUnit('lease-release', 'leases', events),
        recordingUnit('queue-workers', 'claims', events),
      ],
    });
    drain.markReady();
    await drain.beginShutdown('test');
    expect(events).toEqual(['queue-workers', 'lease-release', 'dataset-sync-scheduler']);
  });

  it('drain deadline 到期强制结束并报告未完成单元', async () => {
    const events: string[] = [];
    const drain = createDrainCoordinator({
      units: [
        recordingUnit('queue-workers', 'claims', events, 'hang'),
        recordingUnit('dataset-sync-scheduler', 'leader-lock', events),
      ],
      deadlineMs: 25,
    });
    drain.markReady();
    const result = await drain.beginShutdown('timeout-test');
    expect(result.timedOut).toBe(true);
    expect(result.remainingUnits).toEqual(['queue-workers', 'dataset-sync-scheduler']);
    expect(drain.getState()).toBe('closed');
    expect(events).toEqual([]);
  });

  it('单个单元 close 失败不阻塞其余单元', async () => {
    const events: string[] = [];
    const failing: RuntimeUnit = {
      name: 'failing-unit',
      phase: 'claims',
      close: async () => {
        throw new RangeError('unit failed');
      },
    };
    const drain = createDrainCoordinator({
      units: [failing, recordingUnit('dataset-sync-scheduler', 'leader-lock', events)],
    });
    drain.markReady();
    const result = await drain.beginShutdown('test');
    expect(result).toEqual({ timedOut: false, remainingUnits: [] });
    expect(events).toEqual(['dataset-sync-scheduler']);
  });
});

describe('worker runtime 入口 (P3-01)', () => {
  it('http 角色不装配运行时、不启动领取单元', async () => {
    let bootstrapCalled = false;
    let unitsCreated = false;
    const handle = await startWorkerRuntime({
      config: fakeConfig('http'),
      installSignalHandlers: false,
      bootstrapRuntime: async () => {
        bootstrapCalled = true;
        return fakeRuntime('http');
      },
      createUnits: () => {
        unitsCreated = true;
        return [];
      },
    });
    expect(bootstrapCalled).toBe(false);
    expect(unitsCreated).toBe(false);
    expect(handle.runtime).toBeUndefined();
    expect(handle.drain.getState()).toBe('ready');
  });

  it('worker 角色装配运行时并按 停止领取 → leader lock 顺序关闭', async () => {
    const events: string[] = [];
    const runtime = fakeRuntime('worker');
    let receivedDrain: (() => Promise<unknown>) | undefined;
    const handle = await startWorkerRuntime({
      config: fakeConfig('worker'),
      installSignalHandlers: false,
      bootstrapRuntime: async (options) => {
        receivedDrain = options?.drain;
        return runtime;
      },
      createUnits: () => [
        recordingUnit('queue-workers', 'claims', events),
        recordingUnit('dataset-sync-scheduler', 'leader-lock', events),
      ],
    });
    expect(handle.runtime).toBe(runtime);
    expect(handle.drain.getState()).toBe('ready');
    expect(typeof receivedDrain).toBe('function');
    const result = await handle.drain.beginShutdown('test');
    expect(result).toEqual({ timedOut: false, remainingUnits: [] });
    expect(events).toEqual(['queue-workers', 'dataset-sync-scheduler']);
  });
});
