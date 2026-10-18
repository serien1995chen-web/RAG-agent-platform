import type { Defect, RunEntry, ScenarioRun } from '../types';

/**
 * 会话级留证：内存 + sessionStorage。
 * 所有写入都经过这里，保证 Run Spine / 缺陷 / 场景共用同一份证据链。
 */

const RUN_KEY = 'kb-demo:runs';
const DEFECT_KEY = 'kb-demo:defects';
const SCENARIO_KEY = 'kb-demo:scenarios';
const IDS_KEY = 'kb-demo:created-ids';

type Listener = () => void;

const listeners = new Set<Listener>();

export interface DemoState {
  runs: RunEntry[];
  defects: Defect[];
  scenarios: ScenarioRun[];
  createdIds: { kind: string; id: string }[];
}

/** getSnapshot 必须返回稳定引用；只在 commit 时替换整个 state。 */
let state: DemoState = { runs: [], defects: [], scenarios: [], createdIds: [] };
let hydrated = false;
/** 单调递增的调用序号；并发请求在 await 前分配，避免同序号。 */
let seqCounter = 0;

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    return (parsed as T) ?? fallback;
  } catch {
    return fallback;
  }
}

function hydrate(): void {
  if (hydrated || typeof window === 'undefined') return;
  hydrated = true;
  state = {
    runs: safeParse<RunEntry[]>(window.sessionStorage.getItem(RUN_KEY), []),
    defects: safeParse<Defect[]>(window.sessionStorage.getItem(DEFECT_KEY), []),
    scenarios: safeParse<ScenarioRun[]>(window.sessionStorage.getItem(SCENARIO_KEY), []),
    createdIds: safeParse<{ kind: string; id: string }[]>(window.sessionStorage.getItem(IDS_KEY), []),
  };
  seqCounter = state.runs.reduce((max, run) => Math.max(max, run.seq), 0);
}

function persist(): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.setItem(RUN_KEY, JSON.stringify(state.runs));
  window.sessionStorage.setItem(DEFECT_KEY, JSON.stringify(state.defects));
  window.sessionStorage.setItem(SCENARIO_KEY, JSON.stringify(state.scenarios));
  window.sessionStorage.setItem(IDS_KEY, JSON.stringify(state.createdIds));
}

function emit(): void {
  for (const listener of listeners) listener();
}

function commit(): void {
  persist();
  emit();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function snapshot(): DemoState {
  hydrate();
  return state;
}

export function nextSeq(): number {
  hydrate();
  seqCounter += 1;
  return seqCounter;
}

export function appendRun(entry: RunEntry): void {
  hydrate();
  state = { ...state, runs: [entry, ...state.runs].slice(0, 500) };
  commit();
}

export function nextDefectId(): string {
  hydrate();
  const max = state.defects.reduce((acc, defect) => {
    const match = /^DEMO-(\d+)$/.exec(defect.id);
    return match ? Math.max(acc, Number(match[1])) : acc;
  }, 0);
  return `DEMO-${String(max + 1).padStart(3, '0')}`;
}

export function addDefect(defect: Defect): void {
  hydrate();
  state = { ...state, defects: [defect, ...state.defects] };
  commit();
}

export function updateDefect(id: string, patch: Partial<Defect>): void {
  hydrate();
  state = {
    ...state,
    defects: state.defects.map((defect) =>
      defect.id === id ? { ...defect, ...patch } : defect,
    ),
  };
  commit();
}

export function saveScenario(run: ScenarioRun): void {
  hydrate();
  state = {
    ...state,
    scenarios: [run, ...state.scenarios.filter((item) => item.startedAt !== run.startedAt)].slice(0, 50),
  };
  commit();
}

export function rememberId(kind: string, id: string): void {
  hydrate();
  if (state.createdIds.some((item) => item.kind === kind && item.id === id)) return;
  state = { ...state, createdIds: [...state.createdIds, { kind, id }] };
  commit();
}

export function clearSession(): void {
  state = { runs: [], defects: [], scenarios: [], createdIds: [] };
  commit();
}

export function isTruncatedEntry(entry: RunEntry): boolean {
  return entry.truncated === true;
}
