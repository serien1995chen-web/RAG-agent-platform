import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const TARGET_CONTRACT_COUNTS = Object.freeze({
  paths: 92,
  operations: 120,
  schemas: 139,
  parameters: 8,
});

/**
 * The only operations allowed through the baseline runtime dispatcher.
 * Keep this list human-readable and sorted by the design grouping.
 */
export const RUNTIME_OPERATION_IDS = Object.freeze([
  'API-HEALTH-LIVE',
  'API-HEALTH-READY',
  'API-OPENAPI',
  'API-OPS-STATUS',
  'API-SPACE-LIST',
  'API-SPACE-CREATE',
  'API-SPACE-GET',
  'API-SPACE-MOVE',
  'API-SPACE-BATCH',
  'API-SPACE-EXPORT',
  'API-SPACE-REFERENCES',
  'API-SPACE-UPDATE',
  'API-SPACE-DELETE',
  'API-DIRECTORY-LIST',
  'API-DIRECTORY-CREATE',
  'API-DIRECTORY-GET',
  'API-DIRECTORY-UPDATE',
  'API-DIRECTORY-MOVE',
  'API-DIRECTORY-DELETE',
  'API-SOURCE-LIST',
  'API-SOURCE-CREATE',
  'API-SOURCE-GET',
  'API-SOURCE-UPDATE',
  'API-SOURCE-MOVE',
  'API-SOURCE-BATCH',
  'API-SOURCE-DELETE',
  'API-SOURCE-PREVIEW',
  'API-SOURCE-DOWNLOAD',
  'API-SOURCE-ARCHIVE',
  'API-UPLOAD-INIT',
  'API-UPLOAD-PRESIGN',
  'API-UPLOAD-PART',
  'API-UPLOAD-COMPLETE',
  'API-UPLOAD-ABORT',
  'API-UPLOAD-GET',
  'API-FILE-PREVIEW',
  'API-FILE-CONTENT',
  'API-FILE-DOWNLOAD',
  'API-SEGMENT-LIST',
  'API-SEGMENT-CREATE',
  'API-SEGMENT-GET',
  'API-SEGMENT-UPDATE',
  'API-SEGMENT-DELETE',
  'API-TAG-LIST',
  'API-TAG-CREATE',
  'API-TAG-GET',
  'API-TAG-UPDATE',
  'API-TAG-DELETE',
  'API-TAG-VALUES',
  'API-TAG-APPLY',
  'API-ACL-GET',
  'API-ACL-UPDATE',
  'API-ACL-RESUME',
  'API-COLLABORATOR-LIST',
  'API-COLLABORATOR-CREATE',
  'API-COLLABORATOR-UPDATE',
  'API-COLLABORATOR-DELETE',
  'API-PERMISSION-ENABLE',
  'API-PERMISSION-DISABLE',
  'API-PERMISSION-DETACH',
  'API-PERMISSION-RESUME',
  'API-OWNERSHIP-TRANSFER',
  'API-RESOURCE-OWNERSHIP-TRANSFER',
  'API-JOB-LIST',
  'API-JOB-GET',
  'API-IMPORT-FILES',
  'API-IMPORT-TEXT',
  'API-IMPORT-URL',
  'API-IMPORT-TEMPLATE',
  'API-IMPORT-BACKUP',
  'API-IMPORT-API-CATALOG',
  'API-IMPORT-API-LIBRARY',
  'API-CONNECTOR-CONNECT',
  'API-CONNECTOR-CATALOG',
  'API-CONNECTOR-IMPORT',
  'API-CONNECTOR-SYNC',
  'API-CONNECTOR-UPDATE',
  'API-CONNECTOR-GET',
  'API-CONNECTOR-DELETE',
  'API-MODEL-LIST',
  'API-MODEL-BINDING-GET',
  'API-MODEL-BINDING-UPDATE',
  'API-MODEL-BINDING-VALIDATE',
  'API-JOB-CREATE',
  'API-JOB-RETRY',
  'API-JOB-CANCEL',
  'API-JOB-PAUSE',
  'API-JOB-RESUME',
  'API-JOB-REPLAY',
  'API-SEGMENT-BATCH',
  'API-SEGMENT-INDEX-CREATE',
  'API-SEGMENT-INDEX-UPDATE',
  'API-SEGMENT-INDEX-DELETE',
  'API-SEGMENT-HISTORY',
  'API-SEGMENT-REINDEX',
]);

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']);
const IDEMPOTENCY_HEADER = 'Idempotency-Key';

function own(value, key) {
  return value !== null && typeof value === 'object' && Object.hasOwn(value, key);
}

function resolveSchemaName(schema) {
  if (!schema || typeof schema !== 'object') return null;
  if (typeof schema.$ref === 'string') return schema.$ref.split('/').at(-1) ?? null;
  if (
    schema.type === 'object' &&
    own(schema.properties, 'data') &&
    typeof schema.properties.data.$ref === 'string'
  ) {
    return schema.properties.data.$ref.split('/').at(-1) ?? null;
  }
  return null;
}

function requestSchemaOf(operation) {
  const schema = operation.requestBody?.content?.['application/json']?.schema;
  return resolveSchemaName(schema);
}

function responseSchemaOf(operation) {
  const status = Object.keys(operation.responses ?? {}).find((code) => /^2\d\d$/.test(code));
  const schema =
    status === undefined
      ? undefined
      : operation.responses[status]?.content?.['application/json']?.schema;
  return resolveSchemaName(schema);
}

function operationEntries(document) {
  const entries = [];
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      if (!HTTP_METHODS.has(method)) continue;
      entries.push({ path, method: method.toUpperCase(), operation });
    }
  }
  return entries.sort((left, right) => {
    const byPath = left.path.localeCompare(right.path);
    return byPath === 0 ? left.method.localeCompare(right.method) : byPath;
  });
}

function groupOf(operationId) {
  if (/^API-(HEALTH|OPENAPI|OPS-STATUS)/.test(operationId)) return 'system';
  if (operationId.startsWith('API-SPACE-')) return 'space';
  if (operationId.startsWith('API-DIRECTORY-')) return 'directory';
  if (operationId.startsWith('API-SOURCE-')) return 'source';
  if (operationId.startsWith('API-SEGMENT-')) return 'segment';
  if (operationId.startsWith('API-TAG-')) return 'tag';
  if (/^API-(ACL|COLLABORATOR|OWNERSHIP|PERMISSION|RESOURCE-OWNERSHIP)/.test(operationId)) {
    return 'access';
  }
  if (operationId.startsWith('API-JOB-')) return 'job';
  if (operationId.startsWith('API-IMPORT-')) return 'import';
  if (operationId.startsWith('API-CONNECTOR-')) return 'connector';
  if (operationId.startsWith('API-UPLOAD-')) return 'upload';
  if (operationId.startsWith('API-FILE-')) return 'file';
  if (operationId.startsWith('API-SEARCH-')) return 'search';
  if (operationId.startsWith('API-CITATION-')) return 'citation';
  if (operationId.startsWith('API-MODEL-')) return 'model';
  if (operationId.startsWith('API-APIKEY-')) return 'api-key';
  if (operationId.startsWith('API-USAGE-')) return 'usage';
  if (operationId.startsWith('API-AUDIT-')) return 'audit';
  if (operationId.startsWith('API-OPS-')) return 'operations';
  if (operationId.startsWith('API-SYNONYM-')) return 'synonym';
  return 'unknown';
}

function stageOf(operationId) {
  if (
    /^API-(IMPORT|CONNECTOR|UPLOAD|FILE)-/.test(operationId) ||
    /^API-(SPACE-(REFERENCES|MOVE|BATCH|EXPORT)|DIRECTORY-MOVE|SOURCE-(MOVE|BATCH|PREVIEW|DOWNLOAD|ARCHIVE))$/.test(
      operationId,
    )
  ) {
    return 'F1';
  }
  if (
    /^API-(SEGMENT-(BATCH|INDEX|HISTORY|REINDEX)|JOB-|MODEL-)/.test(operationId) ||
    operationId === 'API-JOB-CREATE'
  ) {
    return 'F2';
  }
  if (/^API-(SEARCH|CITATION)-/.test(operationId)) return 'F3';
  if (
    /^API-(APIKEY|USAGE|AUDIT|SYNONYM)-/.test(operationId) ||
    /^API-OPS-(CLEANUP|RECONCILE|OUTBOX-REPLAY)$/.test(operationId)
  ) {
    return 'F4';
  }
  return 'BASE';
}

function capabilityIdsOf(operationId) {
  if (operationId === 'API-SPACE-REFERENCES') return ['KB-002', 'KB-003'];
  if (
    [
      'API-SPACE-MOVE',
      'API-SPACE-BATCH',
      'API-SPACE-EXPORT',
      'API-DIRECTORY-MOVE',
      'API-SOURCE-MOVE',
      'API-SOURCE-BATCH',
    ].includes(operationId)
  ) {
    return ['KB-003'];
  }
  if (operationId === 'API-OPENAPI' || operationId.startsWith('API-APIKEY-')) {
    return ['API-001', 'API-003'];
  }
  if (operationId === 'API-OPS-STATUS') return ['OPS-005', 'OPS-001'];
  if (operationId.startsWith('API-HEALTH-')) return ['OPS-005'];
  if (operationId.startsWith('API-SPACE-')) {
    return [
      'KB-001',
      ...(/MOVE|BATCH|EXPORT/.test(operationId) ? ['KB-003'] : []),
      ...(operationId.endsWith('REFERENCES') ? ['KB-002'] : []),
    ];
  }
  if (operationId.startsWith('API-DIRECTORY-') || operationId.startsWith('API-SOURCE-')) {
    return [
      'COL-001',
      ...(/MOVE|BATCH|SYNC|REBUILD|PREVIEW|DOWNLOAD|ARCHIVE/.test(operationId) ? ['COL-002'] : []),
      'COL-004',
    ];
  }
  if (operationId.startsWith('API-SEGMENT-')) {
    return [
      'DATA-001',
      ...(/INDEX|HISTORY|REINDEX|BATCH/.test(operationId) ? ['DATA-002', 'DATA-003'] : []),
      ...(/CREATE|BATCH/.test(operationId) ? ['DATA-004'] : []),
      ...(/INDEX|REINDEX|HISTORY/.test(operationId) ? ['TRAIN-002', 'TRAIN-003', 'TRAIN-004'] : []),
    ];
  }
  if (operationId.startsWith('API-TAG-')) return ['COL-003'];
  if (/^API-(ACL|COLLABORATOR|OWNERSHIP|PERMISSION|RESOURCE-OWNERSHIP)/.test(operationId)) {
    return ['AUTH-001', 'AUTH-002', 'AUTH-003', 'AUTH-004'];
  }
  if (operationId.startsWith('API-JOB-')) return ['TRAIN-001', 'TRAIN-005', 'TRAIN-007'];
  if (operationId.startsWith('API-IMPORT-')) {
    if (operationId.endsWith('FILES')) return ['ING-001'];
    if (operationId.endsWith('TEXT')) return ['ING-002', 'DOWN-004'];
    if (operationId.endsWith('URL')) return ['ING-003'];
    if (operationId.endsWith('TEMPLATE')) return ['ING-004'];
    if (operationId.endsWith('BACKUP')) return ['ING-005'];
    return ['ING-006', 'API-002'];
  }
  if (operationId.startsWith('API-CONNECTOR-')) {
    if (operationId.includes('GET') || operationId.includes('CATALOG')) {
      return ['ING-007', 'ING-008', 'ING-009', 'OPS-005'];
    }
    return ['ING-007', 'ING-008', 'ING-009'];
  }
  if (operationId.startsWith('API-UPLOAD-')) return ['FILE-001', 'FILE-002'];
  if (operationId.startsWith('API-FILE-')) return ['FILE-003', 'FILE-004'];
  if (operationId.startsWith('API-SEARCH-')) {
    if (operationId.endsWith('SEMANTIC')) return ['SEARCH-001', 'DOWN-002'];
    if (operationId.endsWith('FULLTEXT')) return ['SEARCH-002', 'SEARCH-005'];
    if (operationId.endsWith('HYBRID')) {
      return ['SEARCH-002', 'SEARCH-005', 'SEARCH-004', 'DOWN-001', 'DOWN-003'];
    }
    if (operationId.endsWith('IMAGE')) return ['SEARCH-006', 'MULTI-001', 'DOWN-002'];
    if (operationId.endsWith('MULTI')) return ['SEARCH-005', 'SEARCH-007', 'DOWN-001'];
    return ['SEARCH-008'];
  }
  if (operationId.startsWith('API-CITATION-')) return ['SEARCH-009', 'DOWN-003'];
  if (operationId.startsWith('API-MODEL-')) {
    return ['MODEL-001', 'MODEL-002', 'MODEL-003', 'MODEL-004', 'MODEL-005', 'MODEL-006'];
  }
  if (operationId.startsWith('API-USAGE-')) return ['OPS-001', 'OPS-002'];
  if (operationId.startsWith('API-AUDIT-')) return ['OPS-003'];
  if (operationId.startsWith('API-OPS-')) return ['OPS-004', 'FILE-005'];
  if (operationId.startsWith('API-SYNONYM-')) return ['SEARCH-003', 'TRAIN-006'];
  return [];
}

function scopesOf(operation) {
  const scope = operation['x-required-scope'];
  return typeof scope === 'string' && scope.length > 0 ? [scope] : [];
}

function idempotencyOf(operation) {
  return (operation.parameters ?? []).some(
    (parameter) => parameter?.name === IDEMPOTENCY_HEADER && parameter.required === true,
  );
}

export function buildKnowledgeContractArtifacts(repoRoot) {
  const sourcePath = join(
    repoRoot,
    'packages',
    'contracts',
    'openapi',
    'knowledge-target.openapi.json',
  );
  const document = JSON.parse(readFileSync(sourcePath, 'utf8'));
  const entries = operationEntries(document);
  const actualCounts = {
    paths: Object.keys(document.paths ?? {}).length,
    operations: entries.length,
    schemas: Object.keys(document.components?.schemas ?? {}).length,
    parameters: Object.keys(document.components?.parameters ?? {}).length,
  };
  const problems = [];
  for (const [key, expected] of Object.entries(TARGET_CONTRACT_COUNTS)) {
    if (actualCounts[key] !== expected) {
      problems.push(`${key} 应为 ${expected}，实际 ${actualCounts[key]}`);
    }
  }

  const routes = entries.map(({ path, method, operation }) => {
    const operationId = operation.operationId;
    const runtime = RUNTIME_OPERATION_IDS.includes(operationId);
    const stage = runtime ? 'BASE' : stageOf(operationId);
    const capabilityIds = capabilityIdsOf(operationId);
    return {
      operationId,
      method,
      path,
      group: groupOf(operationId),
      requestSchema: requestSchemaOf(operation),
      responseSchema: responseSchemaOf(operation),
      scopes: scopesOf(operation),
      idempotent: idempotencyOf(operation),
      rateLimit: operation['x-rate-limit'] ?? null,
      timeoutMs: operation['x-timeout-ms'] ?? null,
      audit: operation['x-audit'] === true,
      downstreamAllowed: operation['x-downstream-allowed'] === true,
      runtime,
      stage,
      targetSection: '9.2',
      accId: capabilityIds[0] === undefined ? null : `ACC-CAP-${capabilityIds[0]}`,
      capabilityIds,
    };
  });

  const seen = new Set();
  const operationKeys = new Set();
  for (const route of routes) {
    if (seen.has(route.operationId)) problems.push(`重复 operationId: ${route.operationId}`);
    seen.add(route.operationId);
    const key = `${route.method} ${route.path}`;
    if (operationKeys.has(key)) problems.push(`重复 method+path: ${key}`);
    operationKeys.add(key);
  }

  const runtimeRoutes = routes.filter((route) => route.runtime);
  const runtimeIds = runtimeRoutes.map((route) => route.operationId).sort();
  const expectedRuntimeIds = [...RUNTIME_OPERATION_IDS].sort();
  if (runtimeIds.length !== RUNTIME_OPERATION_IDS.length) {
    problems.push(`runtime 应为 ${RUNTIME_OPERATION_IDS.length}，实际 ${runtimeIds.length}`);
  }
  if (runtimeIds.join('\n') !== expectedRuntimeIds.join('\n')) {
    problems.push('runtime allowlist 与目标合同 operationId 不一致');
  }

  const deferredRoutes = routes.filter((route) => !route.runtime);
  const expectedDeferredCount = routes.length - RUNTIME_OPERATION_IDS.length;
  if (deferredRoutes.length !== expectedDeferredCount) {
    problems.push(`deferred 应为 ${expectedDeferredCount}，实际 ${deferredRoutes.length}`);
  }
  if (problems.length > 0) {
    const error = new Error(problems.join('\n'));
    error.problems = problems;
    throw error;
  }

  const outputDocument = {
    ...document,
    'x-kb-contract': {
      version: '1.0.0',
      source: document['x-contract-source'],
      paths: actualCounts.paths,
      operations: actualCounts.operations,
      schemas: actualCounts.schemas,
      parameters: actualCounts.parameters,
      runtimeOperations: runtimeRoutes.length,
      deferredOperations: deferredRoutes.length,
      canonicalCollections: 23,
      vectorProfiles: 4,
      canonicalQueues: 13,
    },
  };

  const fullRegistry = {
    schemaVersion: 1,
    counts: actualCounts,
    routes,
  };
  const runtimeRegistry = {
    schemaVersion: 1,
    count: runtimeRoutes.length,
    operations: runtimeRoutes,
  };
  const deferredManifest = {
    schemaVersion: 1,
    count: deferredRoutes.length,
    status: 'DEFERRED',
    operations: deferredRoutes.map((route) => ({
      ...route,
      runtime: false,
      reason: 'OUT_OF_ARCHITECTURE_BASELINE_RUNTIME_SCOPE',
      targetSection: '9.2',
    })),
  };

  const schemaNames = Object.keys(document.components?.schemas ?? {}).sort();
  const schemaPropertyTypes = Object.entries(document.components?.schemas ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, schema]) => {
      const properties = Object.keys(schema?.properties ?? {}).sort();
      return `  ${JSON.stringify(name)}: ${properties.map((property) => JSON.stringify(property)).join(' | ') || 'never'};`;
    });
  const requiredSchemaPropertyTypes = Object.entries(document.components?.schemas ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, schema]) => {
      const required = Array.isArray(schema?.required) ? [...schema.required].sort() : [];
      return `  ${JSON.stringify(name)}: ${required.map((property) => JSON.stringify(property)).join(' | ') || 'never'};`;
    });
  const clientTypes = `// Generated by pnpm openapi:generate. Do not edit manually.
export type OperationId =
${routes.map((route) => `  | '${route.operationId}'`).join('\n')};

export type RuntimeOperationId =
${runtimeRoutes.map((route) => `  | '${route.operationId}'`).join('\n')};

export type DeferredOperationId =
${deferredRoutes.map((route) => `  | '${route.operationId}'`).join('\n')};

export type SchemaName =
${schemaNames.map((name) => `  | '${name}'`).join('\n')};

export interface SchemaPropertyMap {
${schemaPropertyTypes.join('\n')}
}

export interface RequiredSchemaPropertyMap {
${requiredSchemaPropertyTypes.join('\n')}
}

export interface RuntimeRouteMethodPathMap {
${runtimeRoutes
  .map((route) => `  '${route.operationId}': '${route.method} ${route.path}';`)
  .join('\n')}
}

export interface DeferredRouteMethodPathMap {
${deferredRoutes
  .map((route) => `  '${route.operationId}': '${route.method} ${route.path}';`)
  .join('\n')}
}
`;

  return {
    actualCounts,
    document: outputDocument,
    fullRegistry,
    runtimeRegistry,
    deferredManifest,
    clientTypes,
  };
}

export function serializeArtifacts(artifacts) {
  return {
    'packages/contracts/openapi/openapi.json': `${JSON.stringify(artifacts.document, null, 2)}\n`,
    'packages/contracts/openapi/client-types.d.ts': artifacts.clientTypes,
    'packages/contracts/src/openapi/route-registry.data.json': `${JSON.stringify(
      artifacts.fullRegistry,
      null,
      2,
    )}\n`,
    'packages/contracts/src/openapi/runtime-registry.data.json': `${JSON.stringify(
      artifacts.runtimeRegistry,
      null,
      2,
    )}\n`,
    'packages/contracts/src/openapi/deferred-manifest.data.json': `${JSON.stringify(
      artifacts.deferredManifest,
      null,
      2,
    )}\n`,
  };
}

export function validateContractClosure(repoRoot) {
  try {
    buildKnowledgeContractArtifacts(repoRoot);
    return [];
  } catch (error) {
    return Array.isArray(error?.problems) ? error.problems : [String(error)];
  }
}
