import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const S11_EXCLUDED_IDS = Object.freeze(['KB-004', 'ING-010', 'MULTI-002', 'MULTI-003']);
export const S11_SCOPE_PROFILE = 'knowledge-usability-v1';
export const S11_DEFERRED_CAPABILITY_IDS = Object.freeze(['ING-008', 'ING-009', 'PARSE-002']);
export const S11_DEFERRED_CROSS_TEST_IDS = Object.freeze(['TEST-X-SAAS-READY']);

export const S11_CROSS_TEST_IDS = Object.freeze([
  'TEST-X-OPENAPI',
  'TEST-X-TENANT-GUARD',
  'TEST-X-ACL-INHERIT',
  'TEST-X-SEARCH-REAUTH',
  'TEST-X-PGVECTOR-PARTIAL',
  'TEST-X-OUTBOX-CRASH',
  'TEST-X-UPLOAD-MULTIPART',
  'TEST-X-UPLOAD-403',
  'TEST-X-OCR-TIMEOUT',
  'TEST-X-CONNECTOR-TOKEN',
  'TEST-X-CONNECTOR-DELETE',
  'TEST-X-DEEP-BUDGET',
  'TEST-X-IMAGE-CAPTION',
  'TEST-X-FRONTEND-IMPORT',
  'TEST-X-FRONTEND-A11Y',
  'TEST-X-PERF-SEARCH',
  'TEST-X-PERF-IMPORT',
  'TEST-X-SECURITY-UPLOAD',
  'TEST-X-SECURITY-URL',
  'TEST-X-SECRET-LEAK',
  'TEST-X-BACKUP-RESTORE',
  'TEST-X-COMPOSE-READY',
  'TEST-X-SAAS-READY',
  'TEST-X-SCOPE-GUARD',
  'TEST-X-SYNONYM-REBUILD',
  'TEST-X-TAG-FILTER-TYPES',
  'TEST-X-SOURCE-SEARCH-DISABLED',
  'TEST-X-PERMISSION-SWITCH',
  'TEST-X-REFERENCE-DELETE',
  'TEST-X-PROVIDER-CONTRACT',
  'TEST-X-HALFVEC-3072',
  'TEST-X-CLOUD-UNVERIFIED',
  'TEST-X-DOWNSTREAM-CITATION',
]);

const SEARCH_T01 = new Set([
  'SEARCH-001',
  'SEARCH-002',
  'SEARCH-003',
  'SEARCH-004',
  'SEARCH-005',
  'SEARCH-007',
  'SEARCH-009',
]);
const SEARCH_T02 = new Set(['SEARCH-006', 'SEARCH-008']);
const MODEL_T07 = new Set(['MODEL-001']);
const FILE_T05 = new Set(['FILE-004', 'FILE-005']);
const TRAIN_T05 = new Set(['TRAIN-001', 'TRAIN-002', 'TRAIN-005']);
const OPS_T05 = new Set(['OPS-001', 'OPS-002', 'OPS-003', 'OPS-004', 'OPS-005']);

export function taskTraceOf(capabilityId) {
  if (S11_EXCLUDED_IDS.includes(capabilityId)) return 'T04/T08';
  if (capabilityId === 'COL-004') return 'T01/T04/T08';
  if (capabilityId === 'ING-003') return 'T01/T04/T08';
  if (['ING-001', 'ING-002', 'ING-004', 'ING-005'].includes(capabilityId)) {
    return 'T01/T03/T08';
  }
  if (
    capabilityId.startsWith('ING-006') ||
    ['ING-007', 'ING-008', 'ING-009'].includes(capabilityId)
  ) {
    return 'T01/T02/T08';
  }
  if (FILE_T05.has(capabilityId)) return 'T01/T04/T05/T08';
  if (capabilityId.startsWith('FILE-')) return 'T01/T04/T08';
  if (['PARSE-002', 'PARSE-005'].includes(capabilityId)) return 'T01/T02/T08';
  if (capabilityId.startsWith('PARSE-')) return 'T01/T03/T08';
  if (TRAIN_T05.has(capabilityId)) return 'T01/T03/T05/T08';
  if (capabilityId.startsWith('TRAIN-')) return 'T01/T03/T08';
  if (SEARCH_T01.has(capabilityId)) return 'T01/T03/T04/T06/T08';
  if (SEARCH_T02.has(capabilityId)) return 'T01/T02/T04/T06/T08';
  if (MODEL_T07.has(capabilityId)) return 'T01/T02/T07/T08';
  if (capabilityId.startsWith('MODEL-')) return 'T01/T02/T08';
  if (capabilityId === 'MULTI-001') return 'T01/T02/T06/T08';
  if (
    capabilityId.startsWith('AUTH-') ||
    ['API-002', ...Array.from({ length: 4 }, (_, index) => `DOWN-00${index + 1}`)].includes(
      capabilityId,
    )
  ) {
    return 'T01/T04/T08';
  }
  if (capabilityId === 'API-001' || capabilityId === 'API-003') {
    return 'T01/T04/T07/T08';
  }
  if (OPS_T05.has(capabilityId)) {
    return capabilityId === 'OPS-005' ? 'T01/T05/T07/T08' : 'T01/T05/T08';
  }
  if (
    capabilityId.startsWith('KB-') ||
    capabilityId.startsWith('COL-') ||
    capabilityId.startsWith('DATA-')
  ) {
    return 'T01/T06/T08';
  }
  return 'T01/T06/T08';
}

export function blockingTestOf(capabilityId) {
  return S11_EXCLUDED_IDS.includes(capabilityId)
    ? `TEST-EXCLUDED-${capabilityId}`
    : `TEST-${capabilityId}-BLOCK`;
}

export function loadCapabilities(repoRoot) {
  const manifest = JSON.parse(
    readFileSync(
      join(repoRoot, 'packages', 'contracts', 'src', 'knowledge', 'canonical-manifest.data.json'),
      'utf8',
    ),
  );
  return manifest.capabilities;
}

export function buildTemplateRows(repoRoot, scopeProfile = 'canonical-v1') {
  const capabilities = loadCapabilities(repoRoot);
  if (capabilities.length !== 73)
    throw new Error(`expected 73 capabilities, got ${capabilities.length}`);
  return capabilities.map((capability) => ({
    capability: capability.id,
    type: capability.status,
    taskTrace: taskTraceOf(capability.id),
    testId: blockingTestOf(capability.id),
    status:
      capability.status === 'EXCLUDED'
        ? 'EXCLUDED'
        : scopeProfile === S11_SCOPE_PROFILE &&
            S11_DEFERRED_CAPABILITY_IDS.includes(capability.id)
          ? 'DEFERRED_BY_SCOPE'
          : 'NOT_RUN',
    commandEvidence:
      capability.status === 'EXCLUDED'
        ? 'zero-implementation guard'
        : scopeProfile === S11_SCOPE_PROFILE &&
            S11_DEFERRED_CAPABILITY_IDS.includes(capability.id)
          ? 'deferred capability zero-real-call guard'
          : '',
    provider:
      capability.status === 'EXCLUDED'
        ? 'N/A'
        : scopeProfile === S11_SCOPE_PROFILE &&
            S11_DEFERRED_CAPABILITY_IDS.includes(capability.id)
          ? 'DEFERRED_BY_SCOPE'
          : 'BLOCKED',
    risk:
      capability.status === 'EXCLUDED'
        ? 'zero implementation must remain'
        : scopeProfile === S11_SCOPE_PROFILE &&
            S11_DEFERRED_CAPABILITY_IDS.includes(capability.id)
          ? 'deferred by developer; canonical W4 remains incomplete'
          : 'candidate, S10 merge and real-provider evidence unavailable',
  }));
}

export function developmentTestIds(repoRoot) {
  return loadCapabilities(repoRoot)
    .filter((capability) => capability.status !== 'EXCLUDED')
    .map((capability) => blockingTestOf(capability.id));
}

export function scopedDevelopmentTestIds(repoRoot) {
  return loadCapabilities(repoRoot)
    .filter(
      (capability) =>
        capability.status !== 'EXCLUDED' &&
        !S11_DEFERRED_CAPABILITY_IDS.includes(capability.id),
    )
    .map((capability) => blockingTestOf(capability.id));
}

export function deferredCapabilityTestIds() {
  return S11_DEFERRED_CAPABILITY_IDS.map(blockingTestOf);
}

export function scopeCounts(repoRoot, scopeProfile = 'canonical-v1') {
  const capabilities = loadCapabilities(repoRoot);
  const excluded = capabilities.filter((capability) => capability.status === 'EXCLUDED').length;
  const deferred =
    scopeProfile === S11_SCOPE_PROFILE ? S11_DEFERRED_CAPABILITY_IDS.length : 0;
  const development = capabilities.length - excluded;
  const inScopeDevelopment = development - deferred;
  const data = capabilities.filter((capability) => capability.status === 'DATA');
  const deferredData =
    scopeProfile === S11_SCOPE_PROFILE
      ? S11_DEFERRED_CAPABILITY_IDS.filter((id) => data.some((item) => item.id === id)).length
      : 0;
  return {
    scopeProfile,
    total: capabilities.length,
    base: capabilities.filter((capability) => capability.status === 'BASE').length,
    data: data.length,
    excluded,
    canonicalDevelopment: development,
    deferred,
    inScopeDevelopment,
    inScopeData: data.length - deferredData,
    deferredIds: scopeProfile === S11_SCOPE_PROFILE ? [...S11_DEFERRED_CAPABILITY_IDS] : [],
  };
}
