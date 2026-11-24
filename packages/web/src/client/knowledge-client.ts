'use client';

import type { KnowledgeProblem } from '@kb/contracts';

export interface ConsoleSession {
  workspaceId: string;
  memberId: string;
  scopes: string[];
  isWorkspaceOwner: boolean;
  expiresIn: number;
}

export interface ConsoleDirectoryMember {
  memberId: string;
  name: string;
  avatarUrl?: string;
  departmentIds?: string[];
  groupIds?: string[];
}

export interface ConsoleDirectoryUnit {
  id: string;
  name: string;
  parentId?: string | null;
}

export interface ConsoleDirectory {
  members: ConsoleDirectoryMember[];
  departments: ConsoleDirectoryUnit[];
  groups: ConsoleDirectoryUnit[];
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
let directoryPromise: Promise<ConsoleDirectory> | undefined;

function timeoutSignal(timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('Request timed out', 'TimeoutError')),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs: number) {
  const timeout = timeoutSignal(timeoutMs);
  try {
    return await fetch(input, { ...init, signal: timeout.signal });
  } finally {
    timeout.clear();
  }
}

export function ensureConsoleSession(): Promise<ConsoleSession> {
  sessionPromise ??= fetchWithTimeout(
    '/api/console/session',
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    },
    15_000,
  )
    .then(async (response) => {
      if (!response.ok) {
        throw new ConsoleSessionError();
      }
      return (await response.json()) as ConsoleSession;
    })
    .catch((error) => {
      sessionPromise = undefined;
      throw error;
    });
  return sessionPromise;
}

export function ensureConsoleDirectory(): Promise<ConsoleDirectory> {
  directoryPromise ??= fetchWithTimeout(
    '/api/console/directory',
    {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    },
    15_000,
  )
    .then(async (response) => {
      if (!response.ok) {
        throw new ConsoleSessionError();
      }
      return (await response.json()) as ConsoleDirectory;
    })
    .catch((error) => {
      directoryPromise = undefined;
      throw error;
    });
  return directoryPromise;
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
  const response = await fetchWithTimeout(
    path,
    {
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
    },
    30_000,
  );
  if (response.status === 204) {
    return undefined as T;
  }
  const payload = (await response.json()) as
    | { success: true; data: T; traceId: string; requestId: string }
    | KnowledgeProblem;
  if (!response.ok || !payload.success) {
    const problem = payload as KnowledgeProblem;
    throw new KnowledgeRequestError(response.status, problem);
  }
  return payload.data;
}

export async function knowledgeBinaryRequest<T>(
  path: string,
  body: Blob | ArrayBuffer | Uint8Array,
  options: {
    method?: 'PUT' | 'POST';
    idempotencyKey?: string;
  } = {},
): Promise<T> {
  if (!path.startsWith('/v1/knowledge/')) {
    throw new ConsoleRequestPathError();
  }
  const session = await ensureConsoleSession();
  const method = options.method ?? 'PUT';
  const requestBody =
    body instanceof Blob
      ? body
      : new Blob([body instanceof Uint8Array ? new Uint8Array(body).buffer : body]);
  const response = await fetchWithTimeout(
    path,
    {
      method,
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        'content-type': 'application/octet-stream',
        'X-Workspace-Id': session.workspaceId,
        'Idempotency-Key': options.idempotencyKey ?? idempotencyKey(),
      },
      body: requestBody,
    },
    120_000,
  );
  const payload = (await response.json()) as
    | { success: true; data: T; traceId: string; requestId: string }
    | KnowledgeProblem;
  if (!response.ok || !payload.success) {
    throw new KnowledgeRequestError(response.status, payload as KnowledgeProblem);
  }
  return payload.data;
}
