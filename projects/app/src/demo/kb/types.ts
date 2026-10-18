/** 验收平台共用类型（demo 自有，不进入共享契约包）。 */

export interface ApiEnvelope<T> {
  code: number;
  statusText?: string;
  message?: string;
  messageKey?: string;
  params?: Record<string, unknown>;
  data?: T | null;
  errorType?: string | null;
  retryable?: string | null;
  severity?: string | null;
  requestId?: string;
  zodError?: unknown;
}

export interface RunEntry {
  seq: number;
  at: string;
  method: string;
  path: string;
  status: number;
  code: number;
  messageKey?: string;
  params?: Record<string, unknown>;
  requestId?: string;
  durationMs: number;
  requestBody?: unknown;
  responseBody?: unknown;
  truncated?: boolean;
  scenarioId?: string;
  stepId?: string;
  transportError?: string;
}

export type DefectSeverity = 'blocker' | 'high' | 'medium' | 'low';

export type DefectArea =
  | 'dataset'
  | 'collection'
  | 'data'
  | 'search'
  | 'training'
  | 'delete'
  | 'acl'
  | 'file'
  | 'import-export'
  | 'ui';

export type DefectCategory =
  | 'BACKEND-BUG'
  | 'BACKEND-GAP'
  | 'UI-BUG'
  | 'CONTRACT-MISMATCH'
  | 'ENV-BLOCKER'
  | 'FASTGPT-DIFF';

export interface Defect {
  id: string;
  title: string;
  severity: DefectSeverity;
  area: DefectArea;
  category: DefectCategory;
  expected: string;
  actual: string;
  steps: string[];
  runEntryRef: number;
  requestId?: string;
  createdAt: string;
  status: 'open';
  note?: string;
}

export type StepStatus = 'idle' | 'running' | 'passed' | 'failed' | 'blocked' | 'skipped';

export interface ScenarioStepState {
  stepId: string;
  title: string;
  status: StepStatus;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  runEntrySeq?: number;
  detail?: string;
}

export interface ScenarioRun {
  scenarioId: string;
  title: string;
  startedAt: string;
  finishedAt?: string;
  baseline: { commit: string; branch: string };
  environment: { appUrl: string; workerMode: string };
  steps: ScenarioStepState[];
  summary: { passed: number; failed: number; blocked: number };
  createdIds: { kind: string; id: string }[];
}

export interface RouteEntry {
  routeId: string;
  method: string;
  path: string;
  group: string;
  implemented: boolean;
  source: string;
}
