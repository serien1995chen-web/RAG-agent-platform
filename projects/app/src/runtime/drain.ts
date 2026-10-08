import { ConfigValidationException } from '@kb/service';

export type DrainState = 'starting' | 'ready' | 'closing' | 'closed';

/** 关闭阶段顺序（设计文档 6.5.1）：停止领取 → 释放任务租约 → 释放 leader lock。 */
export type DrainPhase = 'claims' | 'leases' | 'leader-lock';

export interface RuntimeUnit {
  name: string;
  phase: DrainPhase;
  close(): Promise<void>;
}

export interface DrainResult {
  timedOut: boolean;
  remainingUnits: string[];
}

export interface DrainCoordinator {
  getState(): DrainState;
  getResult(): DrainResult | undefined;
  /** 仅允许在 starting 状态注册；关闭顺序按 phase 排序，不受注册顺序影响。 */
  register(unit: RuntimeUnit): void;
  markReady(): void;
  /** 幂等：重复调用返回同一次关闭的结果。 */
  beginShutdown(reason: string): Promise<DrainResult>;
}

/** A2：drain deadline 使用显式参数（默认常量，可被 worker 入口覆盖），不新增配置字段。 */
export const DEFAULT_DRAIN_DEADLINE_MS = 30_000;

const PHASE_ORDER: readonly DrainPhase[] = ['claims', 'leases', 'leader-lock'];

export interface DrainCoordinatorOptions {
  units?: readonly RuntimeUnit[];
  deadlineMs?: number;
  onUnitError?: (unit: string, error: unknown) => void;
}

export function createDrainCoordinator(options: DrainCoordinatorOptions = {}): DrainCoordinator {
  const deadlineMs = options.deadlineMs ?? DEFAULT_DRAIN_DEADLINE_MS;
  const units: RuntimeUnit[] = [...(options.units ?? [])];
  let state: DrainState = 'starting';
  let result: DrainResult | undefined;
  let shutdownPromise: Promise<DrainResult> | undefined;

  async function closeUnit(unit: RuntimeUnit, budgetMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      unit.close().then(
        () => false,
        (error: unknown) => {
          options.onUnitError?.(unit.name, error);
          return false;
        },
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), budgetMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    return timedOut;
  }

  async function runShutdown(_reason: string): Promise<DrainResult> {
    state = 'closing';
    const ordered = [...units].sort(
      (left, right) => PHASE_ORDER.indexOf(left.phase) - PHASE_ORDER.indexOf(right.phase),
    );
    const deadlineAt = Date.now() + deadlineMs;
    const remainingUnits: string[] = [];
    let timedOut = false;
    for (let index = 0; index < ordered.length; index += 1) {
      const unit = ordered[index];
      if (!unit) break;
      const budgetMs = deadlineAt - Date.now();
      if (budgetMs <= 0 || (await closeUnit(unit, budgetMs))) {
        timedOut = true;
        remainingUnits.push(...ordered.slice(index).map((unit) => unit.name));
        break;
      }
    }
    result = { timedOut, remainingUnits };
    state = 'closed';
    return result;
  }

  return {
    getState: () => state,
    getResult: () => result,
    register(unit) {
      if (state !== 'starting') {
        throw new ConfigValidationException([
          'DrainCoordinator.register 仅允许在 starting 状态调用',
        ]);
      }
      units.push(unit);
    },
    markReady() {
      if (state === 'starting') state = 'ready';
    },
    beginShutdown(reason) {
      shutdownPromise ??= runShutdown(reason);
      return shutdownPromise;
    },
  };
}
