import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { APIRequestContext } from '@playwright/test';

const root = resolve(import.meta.dirname, '../..');
const pagesRoot = join(root, 'projects', 'app', 'src', 'pages');

export const S11_VIEWPORTS = [
  { name: 'mobile', width: 360, height: 800 },
  { name: 'tablet', width: 768, height: 900 },
  { name: 'desktop', width: 1200, height: 900 },
] as const;

export const S11_CANONICAL_PAGES = [
  { id: 'PAGE-SPACES', route: '/spaces', source: 'spaces/index.tsx', phase: 'existing' },
  { id: 'PAGE-SPACE-NEW', route: '/spaces/new', source: 'spaces/new.tsx', phase: 'existing' },
  {
    id: 'PAGE-SPACE-OVERVIEW',
    route: '/spaces/[spaceId]/overview',
    source: 'spaces/[spaceId]/overview.tsx',
    phase: 'existing',
  },
  {
    id: 'PAGE-SOURCES',
    route: '/spaces/[spaceId]/sources',
    source: 'spaces/[spaceId]/sources.tsx',
    phase: 'existing',
  },
  {
    id: 'PAGE-IMPORT',
    route: '/spaces/[spaceId]/import',
    source: 'spaces/[spaceId]/import.tsx',
    phase: 'existing',
  },
  {
    id: 'PAGE-SEGMENTS',
    route: '/spaces/[spaceId]/segments',
    source: 'spaces/[spaceId]/segments.tsx',
    phase: 'existing',
  },
  {
    id: 'PAGE-SEGMENT-EDIT',
    route: '/spaces/[spaceId]/segments/[segmentId]',
    source: 'spaces/[spaceId]/segments/[segmentId].tsx',
    phase: 'existing',
  },
  {
    id: 'PAGE-JOBS',
    route: '/spaces/[spaceId]/jobs',
    source: 'spaces/[spaceId]/jobs.tsx',
    phase: 'existing',
  },
  {
    id: 'PAGE-SEARCH',
    route: '/spaces/[spaceId]/search',
    source: 'spaces/[spaceId]/search.tsx',
    phase: 'existing',
  },
  {
    id: 'PAGE-IMAGES',
    route: '/spaces/[spaceId]/images',
    source: 'spaces/[spaceId]/images.tsx',
    phase: 'existing',
  },
  {
    id: 'PAGE-TAGS',
    route: '/spaces/[spaceId]/tags',
    source: 'spaces/[spaceId]/tags.tsx',
    phase: 'existing',
  },
  {
    id: 'PAGE-ACCESS',
    route: '/spaces/[spaceId]/access',
    source: 'spaces/[spaceId]/access.tsx',
    phase: 'existing',
  },
  {
    id: 'PAGE-SYNONYMS',
    route: '/spaces/[spaceId]/synonyms',
    source: 'spaces/[spaceId]/synonyms.tsx',
    phase: 'existing',
  },
  {
    id: 'PAGE-CONNECTORS',
    route: '/settings/connectors',
    source: 'settings/connectors.tsx',
    phase: 'existing',
  },
  { id: 'PAGE-USAGE', route: '/usage', source: 'usage.tsx', phase: 's10' },
  { id: 'PAGE-AUDIT', route: '/audit', source: 'audit.tsx', phase: 's10' },
  {
    id: 'PAGE-API-KEYS',
    route: '/settings/api-keys',
    source: 'settings/api-keys.tsx',
    phase: 's10',
  },
  {
    id: 'PAGE-SYSTEM-STATUS',
    route: '/system/status',
    source: 'system/status.tsx',
    phase: 'existing',
  },
] as const;

export type S11CanonicalPage = (typeof S11_CANONICAL_PAGES)[number];

export interface UiMatrixConfiguration {
  baseUrl: string;
  authToken: string;
  evidenceDirectory: string;
  suffix: string;
}

export interface UiMatrixSession {
  workspaceId: string;
  memberId: string;
  storageState: Awaited<ReturnType<APIRequestContext['storageState']>>;
}

export interface UiMatrixWorkspace {
  spaceId: string;
  sourceId: string;
  segmentId: string;
}

interface ApiEnvelope<T> {
  success?: boolean;
  data?: T;
  error?: {
    code?: string;
    message?: string;
  };
}

function requiredUiEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`S11_UI_BLOCKED: missing ${name}`);
  return value;
}

function assertOutsideWorktree(directory: string): string {
  const resolvedDirectory = resolve(directory);
  const lexicalRelative = relative(root, resolvedDirectory);
  if (
    lexicalRelative === '' ||
    (!lexicalRelative.startsWith('..') && !isAbsolute(lexicalRelative))
  ) {
    throw new Error(`S11_UI_EVIDENCE_DIR must be outside ${root}`);
  }
  mkdirSync(resolvedDirectory, { recursive: true });
  const realDirectory = realpathSync(resolvedDirectory);
  const realRelative = relative(realpathSync(root), realDirectory);
  if (realRelative === '' || (!realRelative.startsWith('..') && !isAbsolute(realRelative))) {
    throw new Error(`S11_UI_EVIDENCE_DIR resolves inside ${root}`);
  }
  return realDirectory;
}

export function startUiMatrix(): UiMatrixConfiguration {
  const rawBaseUrl = requiredUiEnv('S11_UI_BASE_URL');
  const baseUrl = new URL(rawBaseUrl);
  if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
    throw new Error('S11_UI_BASE_URL must use http or https');
  }
  return {
    baseUrl: rawBaseUrl.replace(/\/+$/, ''),
    authToken: requiredUiEnv('S11_UI_AUTH_TOKEN'),
    evidenceDirectory: assertOutsideWorktree(requiredUiEnv('S11_UI_EVIDENCE_DIR')),
    suffix: randomUUID().replaceAll('-', '').slice(0, 12),
  };
}

async function readApiEnvelope<T>(
  request: APIRequestContext,
  path: string,
  input: {
    method: 'POST';
    headers: Record<string, string>;
    body: unknown;
  },
): Promise<T> {
  const response = await request.fetch(path, {
    method: input.method,
    headers: input.headers,
    data: input.body,
  });
  const payload = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok() || payload.success !== true || payload.data === undefined) {
    const code = payload.error?.code ?? 'UNKNOWN';
    throw new Error(
      `S11_UI_FIXTURE_FAILED: ${input.method} ${new URL(path, 'http://fixture').pathname} status=${response.status()} code=${code}`,
    );
  }
  return payload.data;
}

export async function bootstrapUiSession(
  request: APIRequestContext,
  configuration: UiMatrixConfiguration,
): Promise<UiMatrixSession> {
  const response = await request.post('/api/console/session', {
    headers: {
      authorization: `Bearer ${configuration.authToken}`,
      accept: 'application/json',
    },
    data: {},
  });
  if (!response.ok()) {
    throw new Error(`S11_UI_BLOCKED: console session status=${response.status()}`);
  }
  const session = (await response.json()) as {
    workspaceId?: string;
    memberId?: string;
  };
  if (!session.workspaceId || !session.memberId) {
    throw new Error('S11_UI_BLOCKED: console session omitted workspace or member identity');
  }
  return {
    workspaceId: session.workspaceId,
    memberId: session.memberId,
    storageState: await request.storageState(),
  };
}

export async function createUiWorkspace(
  request: APIRequestContext,
  configuration: UiMatrixConfiguration,
  session: UiMatrixSession,
): Promise<UiMatrixWorkspace> {
  const headers = {
    authorization: `Bearer ${configuration.authToken}`,
    'x-workspace-id': session.workspaceId,
    accept: 'application/json',
    'content-type': 'application/json',
  };
  const space = await readApiEnvelope<{ id: string }>(request, '/v1/knowledge/spaces', {
    method: 'POST',
    headers: {
      ...headers,
      'idempotency-key': `s11-ui-space-${configuration.suffix}`,
    },
    body: {
      kind: 'space',
      name: `S11 UI ${configuration.suffix}`,
      accessMode: 'workspace',
      sourceAclMode: 'inherited',
      sourcePermissionEnabled: true,
    },
  });
  const source = await readApiEnvelope<{ id: string }>(
    request,
    `/v1/knowledge/spaces/${space.id}/sources`,
    {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': `s11-ui-source-${configuration.suffix}`,
      },
      body: {
        kind: 'text',
        name: `S11 UI Source ${configuration.suffix}`,
        searchEnabled: true,
        metadata: {},
      },
    },
  );
  const segment = await readApiEnvelope<{ id: string }>(
    request,
    `/v1/knowledge/sources/${source.id}/segments`,
    {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': `s11-ui-segment-${configuration.suffix}`,
      },
      body: {
        question: 'How are release evidence changes handled?',
        answer: 'A changed candidate invalidates both independent evidence gates.',
        searchEnabled: true,
        metadata: { section: 'release-hardening' },
      },
    },
  );
  const created = {
    spaceId: space.id,
    sourceId: source.id,
    segmentId: segment.id,
  };
  try {
    const synonymResponse = await request.post(`/v1/knowledge/spaces/${space.id}/synonyms/files`, {
      headers: {
        authorization: `Bearer ${configuration.authToken}`,
        'x-workspace-id': session.workspaceId,
        accept: 'application/json',
        'idempotency-key': `s11-ui-synonyms-${configuration.suffix}`,
      },
      multipart: {
        enabled: 'true',
        file: {
          name: 's11-synonyms.csv',
          mimeType: 'text/csv',
          buffer: Buffer.from('标准词,同义词\n退款,退货\n配送,发货\n'),
        },
      },
    });
    const synonymPayload = (await synonymResponse.json()) as ApiEnvelope<{ version: number }>;
    if (
      synonymResponse.status() !== 201 ||
      synonymPayload.success !== true ||
      synonymPayload.data === undefined
    ) {
      throw new Error(
        `S11_UI_FIXTURE_FAILED: POST synonym fixture status=${synonymResponse.status()} code=${synonymPayload.error?.code ?? 'UNKNOWN'}`,
      );
    }
  } catch (error) {
    await deleteUiWorkspace(request, configuration, session, created);
    throw error;
  }
  return created;
}

export async function deleteUiWorkspace(
  request: APIRequestContext,
  configuration: UiMatrixConfiguration,
  session: UiMatrixSession,
  workspace: UiMatrixWorkspace,
): Promise<void> {
  const headers = {
    authorization: `Bearer ${configuration.authToken}`,
    'x-workspace-id': session.workspaceId,
    accept: 'application/json',
  };
  const failures: string[] = [];
  const synonymsResponse = await request.get(`/v1/knowledge/spaces/${workspace.spaceId}/synonyms`, {
    headers,
  });
  if (synonymsResponse.ok()) {
    const payload = (await synonymsResponse.json()) as ApiEnvelope<{ version: number }>;
    if (payload.success === true && payload.data) {
      const deleted = await request.delete(`/v1/knowledge/spaces/${workspace.spaceId}/synonyms`, {
        headers: {
          ...headers,
          'content-type': 'application/json',
          'idempotency-key': `s11-ui-cleanup-synonyms-${configuration.suffix}`,
        },
        data: { version: payload.data.version },
      });
      if (![202, 204, 404, 409].includes(deleted.status())) {
        failures.push(`synonyms status=${deleted.status()}`);
      }
    }
  } else if (synonymsResponse.status() !== 404) {
    failures.push(`synonyms read status=${synonymsResponse.status()}`);
  }
  const sourceResponse = await request.delete(`/v1/knowledge/sources/${workspace.sourceId}`, {
    headers: {
      ...headers,
      'idempotency-key': `s11-ui-cleanup-source-${configuration.suffix}`,
    },
  });
  if (![202, 204, 404].includes(sourceResponse.status())) {
    failures.push(`source status=${sourceResponse.status()}`);
  }
  const spaceResponse = await request.get(`/v1/knowledge/spaces/${workspace.spaceId}`, {
    headers,
  });
  if (spaceResponse.ok()) {
    const payload = (await spaceResponse.json()) as ApiEnvelope<{
      version: number;
      referenceRevision: number;
    }>;
    if (payload.success !== true || !payload.data) {
      failures.push('space read returned no data');
    } else {
      const deleted = await request.delete(`/v1/knowledge/spaces/${workspace.spaceId}`, {
        headers: {
          ...headers,
          'content-type': 'application/json',
          'idempotency-key': `s11-ui-cleanup-space-${configuration.suffix}`,
        },
        data: {
          version: payload.data.version,
          expectedReferenceRevision: payload.data.referenceRevision,
          referenceStrategy: 'block',
        },
      });
      if (![202, 204, 404].includes(deleted.status())) {
        failures.push(`space status=${deleted.status()}`);
      }
    }
  } else if (spaceResponse.status() !== 404) {
    failures.push(`space read status=${spaceResponse.status()}`);
  }
  if (failures.length > 0) {
    throw new Error(`S11_UI_FIXTURE_CLEANUP_FAILED: ${failures.join(', ')}`);
  }
}

export function canonicalPageTarget(page: S11CanonicalPage, workspace: UiMatrixWorkspace): string {
  const route = page.route
    .replace('[spaceId]', workspace.spaceId)
    .replace('[segmentId]', workspace.segmentId);
  if (page.id === 'PAGE-SEGMENTS') return `${route}?sourceId=${workspace.sourceId}`;
  if (page.id === 'PAGE-IMPORT') return `${route}?kind=text`;
  if (page.id === 'PAGE-CONNECTORS') return `${route}?spaceId=${workspace.spaceId}`;
  return route;
}

export function uiScreenshotName(pageId: string, viewport: string): string {
  return `${pageId.toLowerCase()}-${viewport}.png`;
}

export function pageSourceExists(page: S11CanonicalPage): boolean {
  return existsSync(join(pagesRoot, page.source));
}

export function existingPageMatrix() {
  return S11_CANONICAL_PAGES.filter((page) => pageSourceExists(page));
}

export function missingPageMatrix() {
  return S11_CANONICAL_PAGES.filter((page) => !pageSourceExists(page));
}

export function phase1UiStatus() {
  const existing = existingPageMatrix();
  const missing = missingPageMatrix();
  return {
    status: missing.length > 0 ? 'BLOCKED' : 'READY',
    existingCount: existing.length,
    expectedPhase1Count: 15,
    finalExpectedCount: 18,
    missing,
    blockers: missing.map((page) => ({
      testId: 'TEST-X-S11-UI-MATRIX',
      pageId: page.id,
      code: 'S10_PAGE_BLOCKED',
    })),
  };
}

export function uiEvidencePath(pageId: string, viewport: string, env = process.env): string {
  const rootDirectory = env.S11_UI_EVIDENCE_DIR?.trim();
  if (!rootDirectory) {
    throw new Error('S11_UI_EVIDENCE_DIR is required for UI screenshots');
  }
  return join(rootDirectory, `${pageId.toLowerCase()}-${viewport}.png`);
}
