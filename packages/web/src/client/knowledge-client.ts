'use client';

import type { KnowledgeProblem } from '@kb/contracts';

export interface ConsoleSession {
  workspaceId: string;
  memberId: string;
  scopes: string[];
  isWorkspaceOwner: boolean;
  expiresIn: number;
}

export class KnowledgeRequestError extends Error {
  constructor(
    readonly status: number,
    readonly problem: KnowledgeProblem,
  ) {
    super(problem.error.message);
    this.name = 'KnowledgeRequestError';
  }
}

export class ConsoleSessionError extends Error {
  constructor() {
    super('Console session is unavailable.');
    this.name = 'ConsoleSessionError';
  }
}

export class ConsoleRequestPathError extends Error {
  constructor() {
    super('Console requests must use /v1/knowledge/*.');
    this.name = 'ConsoleRequestPathError';
  }
}

let sessionPromise: Promise<ConsoleSession> | undefined;

export function ensureConsoleSession(): Promise<ConsoleSession> {
  sessionPromise ??= fetch('/api/console/session', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  }).then(async (response) => {
    if (!response.ok) {
      throw new ConsoleSessionError();
    }
    return (await response.json()) as ConsoleSession;
  });
  return sessionPromise;
}

function idempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

export async function knowledgeRequest<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: unknown;
    headers?: Record<string, string>;
    idempotencyKey?: string;
  } = {},
): Promise<T> {
  if (!path.startsWith('/v1/knowledge/')) {
    throw new ConsoleRequestPathError();
  }
  const session = await ensureConsoleSession();
  const method = options.method ?? 'GET';
  const mutationKey = method === 'GET' ? undefined : (options.idempotencyKey ?? idempotencyKey());
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      'X-Workspace-Id': session.workspaceId,
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(mutationKey !== undefined ? { 'Idempotency-Key': mutationKey } : {}),
      ...(options.headers ?? {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const payload = (await response.json()) as
    | { success: true; data: T; traceId: string; requestId: string }
    | KnowledgeProblem;
  if (!response.ok || !payload.success) {
    const problem = payload as KnowledgeProblem;
    throw new KnowledgeRequestError(response.status, problem);
  }
  return payload.data;
}
