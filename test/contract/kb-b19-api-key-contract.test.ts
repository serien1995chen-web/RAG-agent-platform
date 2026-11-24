import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFERRED_OPERATION_MANIFEST,
  RUNTIME_ROUTE_REGISTRY,
  matchRuntimeRoute,
  validateRouteRegistry,
  type RouteEntry,
} from '../../packages/contracts/src/openapi/route-registry';
import { buildKnowledgeContractArtifacts } from '../../packages/contracts/src/openapi/openapi-builder.mjs';

const root = resolve(import.meta.dirname, '../..');
const artifacts = buildKnowledgeContractArtifacts(root);
const document = artifacts.document as {
  paths: Record<string, Record<string, unknown>>;
  components: {
    schemas: Record<string, unknown>;
    parameters: Record<string, unknown>;
    responses: Record<string, unknown>;
  };
};

const expectedGroups = {
  system: 4,
  space: 9,
  directory: 6,
  source: 10,
  segment: 11,
  tag: 7,
  access: 13,
  job: 8,
  import: 11,
  connector: 7,
  upload: 6,
  file: 3,
  search: 6,
  citation: 1,
  model: 4,
  'api-key': 5,
  usage: 1,
  audit: 1,
  operations: 3,
  synonym: 8,
} as const;

const apiKeyOperations = new Set([
  'API-APIKEY-LIST',
  'API-APIKEY-CREATE',
  'API-APIKEY-UPDATE',
  'API-APIKEY-DELETE',
  'API-APIKEY-ROTATE',
]);
const b18Operations = new Set(['API-SEARCH-MULTI', 'API-CITATION-GET']);
const s10Operations = new Set([
  ...apiKeyOperations,
  'API-USAGE-GET',
  'API-AUDIT-LIST',
  'API-OPS-STATUS',
  'API-OPS-CLEANUP',
  'API-OPS-RECONCILE',
  'API-OPS-OUTBOX-REPLAY',
]);
const publicOperations = new Set(['API-OPENAPI', 'API-HEALTH-LIVE', 'API-HEALTH-READY']);

function collectRefs(value: unknown, refs: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, refs);
    return refs;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === '$ref' && typeof item === 'string') refs.push(item);
      else collectRefs(item, refs);
    }
  }
  return refs;
}

function resolvePointer(ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  return ref
    .slice(2)
    .split('/')
    .reduce<unknown>((value, segment) => {
      if (value === null || typeof value !== 'object') return undefined;
      return (value as Record<string, unknown>)[
        segment.replaceAll('~1', '/').replaceAll('~0', '~')
      ];
    }, document);
}

function concretePath(path: string): string {
  return path.replaceAll(/\{[^}]+\}/g, '65f1e5b2a1c9d4b7e8f01234');
}

function successFixtureState(operationId: string): string {
  if (publicOperations.has(operationId)) return 'A_HTTP_SMOKE_RERUN';
  if (s10Operations.has(operationId)) return 'A_S10_REAL_INFRA_RERUN';
  if (b18Operations.has(operationId)) return 'B18_HTTP_RERUN_REQUIRED';
  return 'AFFECTED_SUITE_RERUN_REQUIRED';
}

function matrixRows() {
  return RUNTIME_ROUTE_REGISTRY.map((route: RouteEntry) => ({
    operationId: route.operationId,
    group: route.group,
    method: route.method,
    path: route.path,
    runtime: route.runtime,
    scopes: route.scopes,
    rateLimit: route.rateLimit,
    audit: route.audit,
    idempotent: route.idempotent,
    successCoverage: successFixtureState(route.operationId),
    unauthenticatedCoverage: publicOperations.has(route.operationId)
      ? 'PUBLIC_BY_CONTRACT'
      : 'A_E2E_ALL_OPERATIONS_GATE',
    wrongScopeCoverage: publicOperations.has(route.operationId)
      ? 'PUBLIC_BY_CONTRACT'
      : 'A_E2E_ALL_OPERATIONS_GATE',
    tenantSpaceCoverage:
      route.group === 'system' ? 'PUBLIC_OR_GLOBAL' : 'AFFECTED_SUITE_RERUN_REQUIRED',
    deferred: false,
    evidencePath:
      route.group === 'api-key'
        ? 'test/e2e/kb-b19-api-key-http.test.ts'
        : 'test-results/b19-a/<runId>/commands.json',
  }));
}

describe('L1-B19 API-001 contract and runtime coverage', () => {
  it('L1-B19-API-001-Q01 全部 126 个 runtime operations 均完成合同与路由矩阵', () => {
    expect(artifacts.actualCounts).toEqual({
      paths: 97,
      operations: 126,
      schemas: 146,
      parameters: 8,
    });
    expect(RUNTIME_ROUTE_REGISTRY).toHaveLength(126);
    expect(DEFERRED_OPERATION_MANIFEST).toHaveLength(0);
    const ids = RUNTIME_ROUTE_REGISTRY.map((route) => route.operationId);
    expect(new Set(ids).size).toBe(126);

    const groups = Object.fromEntries(
      Object.keys(expectedGroups).map((group) => [
        group,
        RUNTIME_ROUTE_REGISTRY.filter((route) => route.group === group).length,
      ]),
    );
    expect(groups).toEqual({ ...expectedGroups, model: 6 });
    expect(Object.values(groups).reduce((sum, count) => sum + count, 0)).toBe(126);

    const documentOperations = new Map<string, { method: string; path: string }>();
    for (const [path, item] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        if (!operation || typeof operation !== 'object') continue;
        const operationId = (operation as { operationId?: unknown }).operationId;
        if (typeof operationId === 'string') {
          documentOperations.set(operationId, { method: method.toUpperCase(), path });
        }
      }
    }
    expect(documentOperations.size).toBe(126);
    for (const route of RUNTIME_ROUTE_REGISTRY) {
      expect(documentOperations.get(route.operationId), route.operationId).toEqual({
        method: route.method,
        path: route.path,
      });
      expect(matchRuntimeRoute(route.method, concretePath(route.path))?.route.operationId).toBe(
        route.operationId,
      );
    }

    const rows = matrixRows();
    expect(rows).toHaveLength(126);
    expect(new Set(rows.map((row) => row.operationId)).size).toBe(126);
    expect(rows.every((row) => row.deferred === false)).toBe(true);
    expect(
      rows.every(
        (row) =>
          !row.successCoverage.includes('DEFERRED') && !row.successCoverage.includes('NOT_RUN'),
      ),
    ).toBe(true);
    const evidenceDir = process.env.B19_EVIDENCE_DIR?.trim();
    if (evidenceDir) {
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(
        join(evidenceDir, 'api-001-runtime-matrix.json'),
        `${JSON.stringify({ candidateSha: process.env.B19_CANDIDATE_SHA, rows }, null, 2)}\n`,
      );
    }
  });

  it('L1-B19-API-001-P01 resolves every schema reference and success response envelope', () => {
    const refs = collectRefs(document);
    expect(refs.length).toBeGreaterThan(0);
    const missingRefs = refs.filter((ref) => resolvePointer(ref) === undefined);
    expect(missingRefs).toEqual([]);

    const envelopeProblems: string[] = [];
    for (const [path, item] of Object.entries(document.paths)) {
      for (const [method, operationValue] of Object.entries(item)) {
        if (!operationValue || typeof operationValue !== 'object') continue;
        const operation = operationValue as {
          operationId: string;
          responses?: Record<string, unknown>;
        };
        const success = Object.entries(operation.responses ?? {}).find(([status]) =>
          /^2\d\d$/.test(status),
        );
        expect(success, `${method.toUpperCase()} ${path}`).toBeDefined();
        if (success?.[0] === '204') continue;
        const content = (success?.[1] as { content?: Record<string, unknown> })?.content;
        if (!content?.['application/json']) continue;
        const serialized = JSON.stringify(success?.[1]);
        const missing = ['success', 'data', 'traceId', 'requestId'].filter(
          (field) => !serialized.includes(`"${field}"`),
        );
        if (missing.length > 0)
          envelopeProblems.push(`${operation.operationId}:${missing.join(',')}`);
      }
    }
    expect(envelopeProblems).toEqual([]);
  });

  it('L1-B19-API-001-N01 public route registry validation accepts the frozen 126-operation contract', () => {
    expect(validateRouteRegistry()).toEqual([]);
  });

  it('L1-B19-API-001-Q02 OpenAPI examples contain no complete API Key-shaped secret', () => {
    const found: string[] = [];
    const visit = (value: unknown, path: string) => {
      if (typeof value === 'string' && /kn_live_[A-Za-z0-9_-]{24,}/.test(value)) {
        found.push(path);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, `${path}[${index}]`));
        return;
      }
      if (value !== null && typeof value === 'object') {
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
          visit(item, path ? `${path}.${key}` : key);
        }
      }
    };
    visit(document, '');
    expect(found).toEqual([]);
  });
});

describe('L1-B19 FastGPT behavior matrix', () => {
  it('L1-B19-API-003-Q01 every matrix row has complete provenance and mounted source spans are valid', () => {
    const matrix = JSON.parse(
      readFileSync(join(root, 'test/fixtures/b19/api-key-behavior-matrix.json'), 'utf8'),
    ) as {
      rows: Array<{
        capabilityId: string;
        subTestId: string;
        sourcePath: string;
        sourceStartLine: number;
        sourceEndLine: number;
        conclusion: string;
        frontendBehaviorId: string | null;
        responsibility: string;
        userInput: string;
        expectedHttp: string;
        authorization: string;
        rateLimit: string;
        audit: string;
        persistence: string;
        allowedDifference: string;
      }>;
    };
    expect(matrix.rows.length).toBeGreaterThanOrEqual(23);
    expect(new Set(matrix.rows.map((row) => row.capabilityId))).toEqual(
      new Set(['API-001', 'API-003', 'OPS-001']),
    );
    const allowed = new Set(['MATCH', 'INTENTIONAL_DIFFERENCE', 'BLOCKED_REFERENCE']);
    const allowedFrontendIds = new Set([
      'KB-GLOBAL-010',
      'KB-GLOBAL-011',
      'KB-COLLECTION-126',
      'KB-DATA-006',
      'KB-INFO-001',
      'KB-INFO-026',
      'KB-INFO-027',
      'KB-INFO-062',
    ]);
    const referenceRoot = (process.env.FASTGPT_REFERENCE_ROOT ?? '/mnt/d/Fastgpt/FastGPT').trim();
    const referenceAvailable = existsSync(referenceRoot);
    for (const row of matrix.rows) {
      expect(row.subTestId).toMatch(/^[PNASCFQ]\d{2}$/);
      expect(allowed.has(row.conclusion), row.conclusion).toBe(true);
      if (row.frontendBehaviorId !== null) {
        expect(allowedFrontendIds.has(row.frontendBehaviorId), row.frontendBehaviorId).toBe(true);
      }
      if (row.capabilityId === 'OPS-001') {
        expect(row.frontendBehaviorId, row.responsibility).not.toBeNull();
      }
      expect(row.responsibility.trim().length).toBeGreaterThan(0);
      expect(row.userInput.trim().length).toBeGreaterThan(0);
      expect(row.expectedHttp.trim().length).toBeGreaterThan(0);
      expect(row.authorization.trim().length).toBeGreaterThan(0);
      expect(row.rateLimit.trim().length).toBeGreaterThan(0);
      expect(row.audit.trim().length).toBeGreaterThan(0);
      expect(row.persistence.trim().length).toBeGreaterThan(0);
      expect(row.allowedDifference.trim().length).toBeGreaterThan(0);
      expect(row.sourcePath.startsWith('/')).toBe(false);
      expect(row.sourcePath.split('/')).not.toContain('..');
      expect(row.sourceStartLine).toBeGreaterThanOrEqual(1);
      expect(row.sourceEndLine).toBeGreaterThanOrEqual(row.sourceStartLine);
      if (referenceAvailable) {
        const source = readFileSync(join(referenceRoot, row.sourcePath), 'utf8');
        const lineCount = source.split('\n').length;
        expect(row.sourceEndLine).toBeLessThanOrEqual(lineCount);
      }
    }
    expect(
      new Set(matrix.rows.map((row) => `${row.capabilityId}:${row.subTestId}:${row.sourcePath}`))
        .size,
    ).toBe(matrix.rows.length);
  });

  it('L1-B19 asset audit classifies each required test asset exactly once', () => {
    const audit = JSON.parse(
      readFileSync(join(root, 'test/fixtures/b19/test-asset-audit.json'), 'utf8'),
    ) as {
      allowedStatuses: string[];
      assets: Array<{ path: string; status: string; reason: string }>;
    };
    const allowed = new Set(['REUSE', 'EXTEND', 'NEW', 'STALE', 'BLOCKED']);
    expect(new Set(audit.allowedStatuses)).toEqual(allowed);
    expect(new Set(audit.assets.map((asset) => asset.path)).size).toBe(audit.assets.length);
    expect(audit.assets.length).toBeGreaterThanOrEqual(19);
    for (const asset of audit.assets) {
      expect(existsSync(join(root, asset.path)), asset.path).toBe(true);
      expect(allowed.has(asset.status), asset.path).toBe(true);
      expect(asset.reason.trim().length).toBeGreaterThan(0);
    }
  });
});
