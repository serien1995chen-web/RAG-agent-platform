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
  import: 10,
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

const deferredOperationIds = new Set(['API-SEARCH-MULTI', 'API-CITATION-GET']);
const opsNotRun = new Set([
  'API-USAGE-GET',
  'API-AUDIT-LIST',
  'API-OPS-STATUS',
  'API-OPS-CLEANUP',
  'API-OPS-RECONCILE',
  'API-OPS-OUTBOX-REPLAY',
]);
const apiKeyOperations = new Set([
  'API-APIKEY-LIST',
  'API-APIKEY-CREATE',
  'API-APIKEY-UPDATE',
  'API-APIKEY-DELETE',
  'API-APIKEY-ROTATE',
]);

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
  if (deferredOperationIds.has(operationId)) return 'DEFERRED_TO_B18';
  if (opsNotRun.has(operationId)) return 'NOT_RUN';
  if (operationId === 'API-OPENAPI') return 'PASS_STATIC';
  if (apiKeyOperations.has(operationId)) return 'PASS_HTTP';
  if (operationId === 'API-HEALTH-LIVE' || operationId === 'API-HEALTH-READY') return 'PASS_HTTP';
  return 'NOT_RUN';
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
    successTestStatus: successFixtureState(route.operationId),
    unauthenticatedTestStatus: 'PENDING',
    wrongScopeTestStatus: 'PENDING',
    tenantSpaceTestStatus: route.group === 'api-key' ? 'PENDING' : 'NOT_APPLICABLE',
    b18Status: deferredOperationIds.has(route.operationId) ? 'DEFERRED_TO_B18' : 'NOT_APPLICABLE',
    opsStatus: opsNotRun.has(route.operationId) ? 'NOT_RUN' : 'NOT_APPLICABLE',
    evidencePath: 'test/e2e/kb-b19-api-key-http.test.ts',
  }));
}

describe('L1-B19 API-001 contract and runtime coverage', () => {
  it('L1-B19-API-001-Q01 全部 123 个 runtime operations 均完成合同与路由矩阵', () => {
    expect(artifacts.actualCounts).toEqual({
      paths: 95,
      operations: 123,
      schemas: 141,
      parameters: 8,
    });
    expect(RUNTIME_ROUTE_REGISTRY).toHaveLength(123);
    expect(DEFERRED_OPERATION_MANIFEST).toHaveLength(0);
    const ids = RUNTIME_ROUTE_REGISTRY.map((route) => route.operationId);
    expect(new Set(ids).size).toBe(123);

    const groups = Object.fromEntries(
      Object.keys(expectedGroups).map((group) => [
        group,
        RUNTIME_ROUTE_REGISTRY.filter((route) => route.group === group).length,
      ]),
    );
    expect(groups).toEqual(expectedGroups);
    expect(Object.values(groups).reduce((sum, count) => sum + count, 0)).toBe(123);

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
    expect(documentOperations.size).toBe(123);
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
    expect(rows).toHaveLength(123);
    expect(new Set(rows.map((row) => row.operationId)).size).toBe(123);
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

  it('L1-B19-API-001-N01 public route registry validation accepts the frozen 123-operation contract', () => {
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
      }>;
    };
    expect(matrix.rows.length).toBeGreaterThanOrEqual(12);
    expect(new Set(matrix.rows.map((row) => row.capabilityId))).toEqual(
      new Set(['API-001', 'API-003']),
    );
    const allowed = new Set(['MATCH', 'INTENTIONAL_DIFFERENCE', 'BLOCKED_REFERENCE']);
    const referenceRoot = (process.env.FASTGPT_REFERENCE_ROOT ?? '/mnt/d/Fastgpt/FastGPT').trim();
    const referenceAvailable = existsSync(referenceRoot);
    for (const row of matrix.rows) {
      expect(row.subTestId).toMatch(/^[PNASCFQ]\d{2}$/);
      expect(allowed.has(row.conclusion), row.conclusion).toBe(true);
      expect(row.frontendBehaviorId).toBeNull();
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
  });
});
