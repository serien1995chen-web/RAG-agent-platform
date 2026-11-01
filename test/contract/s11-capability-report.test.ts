import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  S11_CROSS_TEST_IDS,
  S11_DEFERRED_CAPABILITY_IDS,
  S11_EXCLUDED_IDS,
  S11_SCOPE_PROFILE,
  buildTemplateRows,
  developmentTestIds,
  scopedDevelopmentTestIds,
  scopeCounts,
} from '../../scripts/lib/s11-capability.mjs';
import {
  EXCLUDED_GUARDS,
  EXPECTED_33_CROSS_IDS,
  EXPECTED_69_IDS,
  parseMatrix,
  validateTemplate,
} from '../../scripts/validate-s11-report.mjs';
import { renderBlockedReport, renderProviderMatrix } from '../../scripts/render-s11-evidence.mjs';
import { writeProviderMatrixManifest } from '../../scripts/run-provider-real.mjs';

const root = resolve(import.meta.dirname, '../..');
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function evidenceDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 's11-provider-matrix-'));
  temporaryDirectories.push(directory);
  return directory;
}

function writeEvidence(directory: string, name: string, value: Record<string, unknown>) {
  writeFileSync(join(directory, name), `${JSON.stringify(value)}\n`);
}

function readyEnvironment(directory: string, candidateSha = 'a'.repeat(40)) {
  const profile = (credentials: Record<string, string>) =>
    JSON.stringify({
      endpoint: 'https://ocr.example.invalid',
      credentials,
    });
  return {
    S11_SCOPE_PROFILE: S11_SCOPE_PROFILE,
    S11_PROVIDER_MODE: 'real',
    AIPROXY_MODE: 'openai',
    AIPROXY_BASE_URL: 'https://aiproxy.example.invalid',
    AIPROXY_API_TOKEN: 'test-only-token',
    S11_AIPROXY_LLM_MODEL: 'llm-test',
    S11_AIPROXY_EMBEDDING_MODEL: 'embedding-test',
    S11_AIPROXY_RERANK_MODEL: 'rerank-test',
    S11_AIPROXY_VLM_MODEL: 'vlm-test',
    S11_AIPROXY_VISION_EMBEDDING_MODEL: 'vision-embedding-test',
    S11_AIPROXY_MODEL_MAPPING_APPROVED: 'true',
    S11_OCR_SOMARK_PROFILE_JSON: profile({ apiKey: 'test-only-secret' }),
    S11_OCR_TEXTIN_PROFILE_JSON: profile({
      appId: 'test-only-app',
      secretCode: 'test-only-secret',
    }),
    S11_OCR_DOC2X_PROFILE_JSON: profile({ apiKey: 'test-only-secret' }),
    S11_FEISHU_APP_ID: 'app-id-test',
    S11_FEISHU_APP_SECRET: 'app-secret-test',
    S11_FEISHU_FOLDER_TOKEN: 'folder-token-test',
    S11_FEISHU_DOC_1: 'doc-1',
    S11_FEISHU_DOC_2: 'doc-2',
    S11_EVIDENCE_DIR: directory,
    CANDIDATE_SHA: candidateSha,
    S11_PROVIDER_FIXTURE_SHA256: 'b'.repeat(64),
  };
}

function writeRealEvidence(directory: string, candidateSha = 'a'.repeat(40)) {
  const usage = [{ provider: 'test', unit: 'token', quantity: 1, status: 200 }];
  writeEvidence(directory, 't02-aiproxy.json', {
    testId: 'TEST-X-S11-PROVIDER-REAL',
    candidateSha,
    status: 'REAL_VERIFIED',
    modelRoleCount: 5,
    statuses: { llm: 200, embedding: 200, rerank: 200, vlm: 200, visionEmbedding: 200 },
    usage: {
      llm: { quantity: 1 },
      embedding: { quantity: 1 },
      rerank: { quantity: 1 },
      vlm: { quantity: 1 },
      visionEmbedding: { quantity: 1 },
    },
  });
  writeEvidence(directory, 't02-ocr.json', {
    testId: 'TEST-X-S11-PROVIDER-REAL',
    candidateSha,
    status: 'REAL_VERIFIED',
    sangfor: 'DEFERRED_BY_SCOPE',
    sangforRealCalls: 0,
    results: Object.fromEntries(
      ['somark', 'textin', 'doc2x'].map((provider) => [
        provider,
        { pages: 2, markdownSha256: 'c'.repeat(64), usage },
      ]),
    ),
  });
  writeEvidence(directory, 't02-connectors.json', {
    testId: 'TEST-X-S11-PROVIDER-REAL',
    candidateSha,
    status: 'REAL_VERIFIED',
    documentCount: 2,
    deletePropagation: { verified: true, caseIdHash: 'd'.repeat(64) },
    yuque: 'DEFERRED_BY_SCOPE',
    yuqueRealCalls: 0,
    dingtalk: 'DEFERRED_BY_SCOPE',
    dingtalkRealCalls: 0,
    contentHashes: ['e'.repeat(64), 'f'.repeat(64)],
  });
}

describe('TEST-X-S11-CAPABILITY-MATRIX / TEST-X-S11-EVIDENCE-BINDING', () => {
  it('contains exactly 73 unique rows, 69 development and 4 excluded', () => {
    const text = readFileSync(join(root, 'docs', 'acceptance', 's11-capability-matrix.md'), 'utf8');
    const result = validateTemplate(text, S11_SCOPE_PROFILE);
    expect(result.errors).toEqual([]);
    expect(result.rows).toBe(73);
    expect(new Set(result.ids).size).toBe(73);
    expect(result.ids.filter((id) => S11_EXCLUDED_IDS.includes(id))).toEqual([
      'KB-004',
      'ING-010',
      'MULTI-002',
      'MULTI-003',
    ]);
  });

  it('keeps the 69 blocking test IDs and 33 cross-cutting IDs complete', () => {
    expect(developmentTestIds(root)).toHaveLength(69);
    expect(EXPECTED_69_IDS).toHaveLength(69);
    expect(EXPECTED_33_CROSS_IDS).toHaveLength(33);
    expect(S11_CROSS_TEST_IDS).toHaveLength(33);
    expect(EXCLUDED_GUARDS).toEqual([
      'TEST-EXCLUDED-KB-004',
      'TEST-EXCLUDED-ING-010',
      'TEST-EXCLUDED-MULTI-002',
      'TEST-EXCLUDED-MULTI-003',
    ]);
  });

  it('keeps the phase1 matrix free of PASS and machine-readable', () => {
    const rows = buildTemplateRows(root);
    expect(rows).toHaveLength(73);
    expect(rows.filter((row) => row.status === 'NOT_RUN')).toHaveLength(69);
    expect(rows.filter((row) => row.status === 'EXCLUDED')).toHaveLength(4);
    expect(rows.some((row) => row.status === 'PASS')).toBe(false);
    expect(
      parseMatrix(
        readFileSync(join(root, 'docs', 'acceptance', 's11-capability-matrix.md'), 'utf8'),
      ),
    ).toHaveLength(73);
  });

  it('applies the knowledge-usability-v1 scope without mutating canonical rows', () => {
    const rows = buildTemplateRows(root, S11_SCOPE_PROFILE);
    const counts = scopeCounts(root, S11_SCOPE_PROFILE);
    expect(rows).toHaveLength(73);
    expect(rows.filter((row) => row.status === 'NOT_RUN')).toHaveLength(66);
    expect(rows.filter((row) => row.status === 'DEFERRED_BY_SCOPE')).toHaveLength(3);
    expect(rows.filter((row) => row.status === 'EXCLUDED')).toHaveLength(4);
    expect(
      rows.filter((row) => row.status === 'DEFERRED_BY_SCOPE').map((row) => row.capability),
    ).toEqual(S11_DEFERRED_CAPABILITY_IDS);
    expect(scopedDevelopmentTestIds(root)).toHaveLength(66);
    expect(counts).toMatchObject({
      total: 73,
      base: 12,
      data: 57,
      excluded: 4,
      canonicalDevelopment: 69,
      deferred: 3,
      inScopeDevelopment: 66,
      inScopeData: 54,
    });
  });

  it('renders a 73-row blocked release report without claiming PASS', () => {
    const report = renderBlockedReport(S11_SCOPE_PROFILE);
    expect(parseMatrix(report)).toHaveLength(73);
    expect(report).toContain('Result: `SCOPED_BLOCKED`');
    expect(report).not.toMatch(/\| PASS \|/);
    expect(report).not.toContain('NOT_RUN');
    expect(report.match(/EXCLUDED \|/g)).toHaveLength(4);
    expect(report.match(/DEFERRED_BY_SCOPE \|/g)).toHaveLength(6);
  });

  it('renders all in-scope Providers as external unverified without candidate evidence', () => {
    const directory = evidenceDirectory();
    const result = renderProviderMatrix({
      S11_SCOPE_PROFILE,
      S11_EVIDENCE_DIR: directory,
    });
    expect(result.status).toBe('SCOPED_BLOCKED');
    expect(result.markdown.match(/EXTERNAL_UNVERIFIED/g)).toHaveLength(5);
    expect(result.markdown).not.toContain('REAL_VERIFIED');
    expect(result.markdown).toContain('DEFERRED_BY_SCOPE');
  });

  it('never promotes mock or candidate-mismatched evidence to real', () => {
    const directory = evidenceDirectory();
    const candidateSha = 'a'.repeat(40);
    writeEvidence(directory, 't02-aiproxy.json', {
      testId: 'TEST-X-S11-PROVIDER-REAL',
      candidateSha,
      status: 'MOCK',
    });
    writeEvidence(directory, 't02-ocr.json', {
      testId: 'TEST-X-S11-PROVIDER-REAL',
      candidateSha,
      status: 'MOCK',
    });
    writeEvidence(directory, 't02-connectors.json', {
      testId: 'TEST-X-S11-PROVIDER-REAL',
      candidateSha,
      status: 'MOCK',
    });
    const mocked = renderProviderMatrix(readyEnvironment(directory, candidateSha));
    expect(mocked.status).toBe('SCOPED_BLOCKED');
    expect(mocked.markdown).not.toContain('REAL_VERIFIED');

    writeRealEvidence(directory, candidateSha);
    const mismatched = renderProviderMatrix(readyEnvironment(directory, '9'.repeat(40)));
    expect(mismatched.status).toBe('SCOPED_BLOCKED');
    expect(mismatched.markdown).not.toContain('REAL_VERIFIED');
  });

  it('renders REAL_VERIFIED only from complete safe candidate-bound Provider evidence', () => {
    const directory = evidenceDirectory();
    const candidateSha = 'a'.repeat(40);
    writeRealEvidence(directory, candidateSha);
    const result = renderProviderMatrix(readyEnvironment(directory, candidateSha));
    expect(result.blockers).toEqual([]);
    expect(result.status).toBe('SCOPED_READY');
    expect(result.markdown.match(/REAL_VERIFIED/g)).toHaveLength(5);
    expect(result.markdown.match(/DEFERRED_BY_SCOPE/g)).toHaveLength(3);
    expect(result.markdown).not.toContain('test-only-secret');
    expect(result.markdown).not.toContain('test-only-token');
  });

  it('accepts the external provider matrix manifest without exposing raw values', () => {
    const directory = evidenceDirectory();
    const candidateSha = 'a'.repeat(40);
    const fixtureHash = 'b'.repeat(64);
    writeRealEvidence(directory, candidateSha);
    writeEvidence(directory, 't02-provider-matrix.json', {
      schemaVersion: 1,
      candidateSha,
      fixtureHash,
      files: {
        aiproxy: 't02-aiproxy.json',
        ocr: 't02-ocr.json',
        connectors: 't02-connectors.json',
      },
    });
    const env = {
      ...readyEnvironment(directory, candidateSha),
      CANDIDATE_SHA: undefined,
      S11_PROVIDER_FIXTURE_SHA256: undefined,
    };
    const result = renderProviderMatrix(env);
    expect(result.blockers).toEqual([]);
    expect(result.status).toBe('SCOPED_READY');
    expect(result.candidateSha).toBe(candidateSha);
    expect(result.fixtureHash).toBe(fixtureHash);
    expect(result.inputManifestSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('writes a safe provider matrix run manifest with the real exit status', () => {
    const directory = evidenceDirectory();
    const env = {
      S11_EVIDENCE_DIR: directory,
      CANDIDATE_SHA: 'a'.repeat(40),
      S11_PROVIDER_FIXTURE_SHA256: 'b'.repeat(64),
    };
    const manifestPath = writeProviderMatrixManifest(
      env,
      's11-aiproxy-real',
      0,
      [],
      'pnpm test:provider:real -- s11-aiproxy-real',
    );
    expect(manifestPath).toBe(join(directory, 't02-provider-matrix.json'));
    const manifest = JSON.parse(readFileSync(manifestPath!, 'utf8'));
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      candidateSha: env.CANDIDATE_SHA,
      fixtureHash: env.S11_PROVIDER_FIXTURE_SHA256,
      lastRun: {
        scenario: 's11-aiproxy-real',
        exitCode: 0,
        status: 'REAL_VERIFIED',
        blockerCount: 0,
      },
    });
    expect(JSON.stringify(manifest)).not.toMatch(/token|secret/i);

    writeProviderMatrixManifest(env, 's11-aiproxy-real', 2, ['evidence missing']);
    const failed = JSON.parse(readFileSync(manifestPath!, 'utf8'));
    expect(failed.lastRun).toMatchObject({
      exitCode: 2,
      status: 'FAIL',
      blockerCount: 1,
    });
  });
});
