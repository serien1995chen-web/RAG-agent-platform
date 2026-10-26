export type S5ModelType = 'llm' | 'embedding' | 'rerank' | 'vlm' | 'stt' | 'tts';

export interface S5ModelView {
  modelId: string;
  displayName: string;
  type: S5ModelType;
  capabilities: string[];
  authorized: boolean;
}

export interface S5ModelBindingView {
  modelType: S5ModelType;
  modelId: string;
  displayName: string;
  requiredCapabilities: string[];
  status: 'active' | 'disabled';
}

export type S5ModelParseState =
  | 'idle'
  | 'validating'
  | 'ready'
  | 'saving'
  | 'partial'
  | 'conflict'
  | 'forbidden'
  | 'validation'
  | 'timeout'
  | 'network'
  | 'error';

export interface S5ProblemView {
  messageKey:
    | 'errors.authRequired'
    | 'errors.forbidden'
    | 'errors.notFound'
    | 'errors.validationFailed'
    | 'errors.conflict'
    | 'errors.partialSuccess'
    | 'errors.dependencyTimeout'
    | 'errors.modelFailed'
    | 'errors.modelOutputInvalid'
    | 'errors.internal'
    | 'errors.unknown';
  params: Record<string, string | number>;
  requestId?: string;
  traceId?: string;
}

export type ProviderVerificationLabel = 'real' | 'mock' | 'unverified';

const TYPE_ORDER: readonly S5ModelType[] = ['llm', 'embedding', 'rerank', 'vlm', 'stt', 'tts'];

export function groupModelsByType(
  models: readonly S5ModelView[],
): Array<{ type: S5ModelType; models: S5ModelView[] }> {
  return TYPE_ORDER.map((type) => ({
    type,
    models: models
      .filter((model) => model.authorized && model.type === type)
      .sort((left, right) => left.modelId.localeCompare(right.modelId)),
  })).filter((group) => group.models.length > 0);
}

export function selectedModelCapabilities(
  models: readonly S5ModelView[],
  modelId: string,
): string[] {
  return [...new Set(models.find((model) => model.modelId === modelId)?.capabilities ?? [])].sort();
}

export function canSaveBinding(input: {
  state: S5ModelParseState;
  bindings: readonly S5ModelBindingView[];
}): boolean {
  return (
    input.state === 'ready' &&
    input.bindings.length > 0 &&
    new Set(input.bindings.map((binding) => binding.modelType)).size === input.bindings.length
  );
}

export function providerVerificationLabel(input: {
  mode: 'mock' | 'real' | 'external';
  verified: boolean;
}): ProviderVerificationLabel {
  if (input.mode === 'mock') return 'mock';
  return input.verified ? 'real' : 'unverified';
}

function problemRecord(error: unknown): {
  status?: number;
  code?: string;
  requestId?: string;
  traceId?: string;
  details?: unknown;
} | null {
  if (typeof error !== 'object' || error === null) return null;
  const record = error as Record<string, unknown>;
  const problem =
    typeof record.problem === 'object' && record.problem !== null
      ? (record.problem as Record<string, unknown>)
      : null;
  const body =
    problem && typeof problem.error === 'object' && problem.error !== null
      ? (problem.error as Record<string, unknown>)
      : null;
  if (!problem || !body) return null;
  return {
    status: typeof record.status === 'number' ? record.status : undefined,
    code: typeof body.code === 'string' ? body.code : undefined,
    requestId: typeof problem.requestId === 'string' ? problem.requestId : undefined,
    traceId: typeof problem.traceId === 'string' ? problem.traceId : undefined,
    details: body.details,
  };
}

function messageKeyOfCode(code: string | undefined): S5ProblemView['messageKey'] {
  if (code === 'KNOWLEDGE_AUTH_REQUIRED') return 'errors.authRequired';
  if (code === 'KNOWLEDGE_FORBIDDEN' || code === 'KNOWLEDGE_NOT_FOUND') return 'errors.forbidden';
  if (code === 'KNOWLEDGE_VALIDATION_FAILED') return 'errors.validationFailed';
  if (code === 'KNOWLEDGE_CONFLICT') return 'errors.conflict';
  if (code === 'KNOWLEDGE_PARTIAL_SUCCESS') return 'errors.partialSuccess';
  if (code === 'KNOWLEDGE_DEPENDENCY_TIMEOUT') return 'errors.dependencyTimeout';
  if (code === 'KNOWLEDGE_MODEL_FAILED') return 'errors.modelFailed';
  if (code === 'KNOWLEDGE_MODEL_OUTPUT_INVALID') return 'errors.modelOutputInvalid';
  if (code === 'KNOWLEDGE_INTERNAL_ERROR') return 'errors.internal';
  return 'errors.unknown';
}

export function toS5ProblemView(error: unknown): S5ProblemView {
  const problem = problemRecord(error);
  if (!problem) {
    return { messageKey: 'errors.unknown', params: {} };
  }
  const details =
    typeof problem.details === 'object' && problem.details !== null
      ? (problem.details as Record<string, unknown>)
      : {};
  const params = Object.fromEntries(
    Object.entries(details)
      .filter(([, value]) => typeof value === 'string' || typeof value === 'number')
      .map(([key, value]) => [key, value as string | number]),
  );
  return {
    messageKey: messageKeyOfCode(problem.code),
    params,
    ...(problem.requestId ? { requestId: problem.requestId } : {}),
    ...(problem.traceId ? { traceId: problem.traceId } : {}),
  };
}

export function stateFromProblem(error: unknown): S5ModelParseState {
  const problem = problemRecord(error);
  if (!problem) return 'network';
  if (problem.status === 504 || problem.code === 'KNOWLEDGE_DEPENDENCY_TIMEOUT') return 'timeout';
  if (problem.status === 207 || problem.code === 'KNOWLEDGE_PARTIAL_SUCCESS') return 'partial';
  if (problem.status === 409 || problem.code === 'KNOWLEDGE_CONFLICT') return 'conflict';
  if (
    problem.status === 403 ||
    problem.status === 404 ||
    problem.code === 'KNOWLEDGE_FORBIDDEN' ||
    problem.code === 'KNOWLEDGE_NOT_FOUND'
  ) {
    return 'forbidden';
  }
  if (problem.status === 400 || problem.code === 'KNOWLEDGE_VALIDATION_FAILED') {
    return 'validation';
  }
  return 'error';
}

export function mergeBindingDraft(
  current: readonly S5ModelBindingView[],
  next: S5ModelBindingView,
): S5ModelBindingView[] {
  return [...current.filter((binding) => binding.modelType !== next.modelType), next].sort(
    (left, right) => TYPE_ORDER.indexOf(left.modelType) - TYPE_ORDER.indexOf(right.modelType),
  );
}

export function safeConflictRetryState(
  current: S5ModelParseState,
  draftLength: number,
): { state: S5ModelParseState; keepDraft: boolean } {
  return current === 'conflict'
    ? { state: 'conflict', keepDraft: draftLength > 0 }
    : { state: current, keepDraft: false };
}
