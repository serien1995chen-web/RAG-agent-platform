import { bootstrapRuntime, type ExtendedAppRuntime } from './bootstrap';
import { createDrainCoordinator } from './drain';
import { startWorkerRuntime } from './worker';

let runtimePromise: Promise<ExtendedAppRuntime> | undefined;

export function getRuntime(): Promise<ExtendedAppRuntime> {
  runtimePromise ??= bootstrapRuntime();
  return runtimePromise;
}

export async function closeRuntime(): Promise<void> {
  const runtime = await getRuntime();
  await runtime.shutdown();
  runtimePromise = undefined;
}

export { bootstrapRuntime, createDrainCoordinator, startWorkerRuntime };
export type { ExtendedAppRuntime, RuntimeBootstrapOptions } from './bootstrap';
export type { DrainCoordinator, DrainPhase, DrainResult, DrainState, RuntimeUnit } from './drain';
export type { WorkerRuntimeHandle, WorkerRuntimeOptions } from './worker';
