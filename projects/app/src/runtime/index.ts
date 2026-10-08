import { bootstrapRuntime, type ExtendedAppRuntime } from './bootstrap';

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

export { bootstrapRuntime } from './bootstrap';
export type { ExtendedAppRuntime, RuntimeBootstrapOptions } from './bootstrap';
