import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PROVIDER_SCENARIOS,
  checkEnvironment,
  safeProviderSummary,
} from '../../scripts/check-provider-inputs.mjs';
import { requestedScenario } from '../../scripts/run-provider-real.mjs';

const aiproxyEnv = {
  S11_PROVIDER_MODE: 'real',
  S11_SCOPE_PROFILE: 'knowledge-usability-v1',
  AIPROXY_MODE: 'openai',
  AIPROXY_BASE_URL: 'https://tokendance.space/gateway/v1',
  AIPROXY_API_TOKEN: 'fixture-token-value',
  S11_AIPROXY_LLM_MODEL: 'deepseek-v4.1-flash',
  S11_AIPROXY_EMBEDDING_MODEL: 'qwen3.7-text-embedding',
  S11_AIPROXY_RERANK_MODEL: 'qwen3.7-text-rerank',
  S11_AIPROXY_VLM_MODEL: 'kimi-k2.5',
  S11_AIPROXY_VISION_EMBEDDING_MODEL: 'qwen3.7-text-embedding',
  S11_AIPROXY_MODEL_MAPPING_APPROVED: 'true',
  AIPROXY_MODEL_PROFILE_JSON: JSON.stringify({
    models: [
      {
        id: 'deepseek-v4.1-flash',
        type: 'llm',
        capabilities: ['chat'],
      },
      {
        id: 'qwen3.7-text-embedding',
        type: 'embedding',
        capabilities: ['text-embedding', 'caption-embedding'],
        dimension: 1024,
      },
      {
        id: 'qwen3.7-text-rerank',
        type: 'rerank',
        capabilities: ['rerank'],
      },
      {
        id: 'kimi-k2.5',
        type: 'vlm',
        capabilities: ['vision'],
      },
    ],
  }),
} as const;

const root = resolve(import.meta.dirname, '../..');
const inputScript = resolve(root, 'scripts/check-provider-inputs.mjs');

function runProviderInputCli(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [inputScript, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      ...aiproxyEnv,
      ...env,
    },
  });
}

describe('S11 scenario-scoped Provider inputs', () => {
  it('readies AIProxy-only scenarios without OCR or Feishu fields', () => {
    for (const scenario of [
      's11-aiproxy-real',
      's11-aiproxy-catalog-preflight',
      's11-provider-quota',
    ] as const) {
      const result = checkEnvironment(aiproxyEnv, { scenario });
      expect(result.status).toBe('READY');
      expect(result.providers.map((provider) => provider.provider)).toEqual(['mode', 'aiproxy']);
      expect(result.missingFields).toEqual([]);
    }
  });

  it('keeps the full knowledge-usability profile blocked until OCR and Feishu are supplied', () => {
    const result = checkEnvironment(aiproxyEnv);
    expect(result.status).toBe('SCOPED_BLOCKED');
    expect(result.missingFields).toEqual(
      expect.arrayContaining([
        'S11_OCR_SOMARK_PROFILE_JSON',
        'S11_OCR_TEXTIN_PROFILE_JSON',
        'S11_OCR_DOC2X_PROFILE_JSON',
        'S11_FEISHU_APP_ID',
        'S11_FEISHU_APP_SECRET',
        'S11_FEISHU_FOLDER_TOKEN',
        'S11_FEISHU_DOC_1',
        'S11_FEISHU_DOC_2',
      ]),
    );
  });

  it('fails closed when a required AIProxy model mapping is missing', () => {
    const result = checkEnvironment(
      { ...aiproxyEnv, S11_AIPROXY_EMBEDDING_MODEL: '' },
      { scenario: 's11-aiproxy-real' },
    );
    expect(result.status).toBe('SCOPED_BLOCKED');
    expect(result.missingFields).toContain('S11_AIPROXY_EMBEDDING_MODEL');
  });

  it('rejects an unknown scenario and never selects deferred providers', () => {
    const unknown = checkEnvironment(aiproxyEnv, { scenario: 's11-unknown-scenario' });
    expect(unknown.status).toBe('BLOCKED');
    expect(unknown.invalidFields).toEqual(['scenario.s11-unknown-scenario']);

    expect(PROVIDER_SCENARIOS['s11-aiproxy-real']).toEqual(['aiproxy']);
    const summary = safeProviderSummary(
      {
        ...aiproxyEnv,
        S11_OCR_SANGFOR_PROFILE_JSON: '{invalid-deferred-profile',
        S11_YUQUE_TOKEN: 'fixture-deferred-token',
        S11_DINGTALK_APP_KEY: 'fixture-deferred-key',
      },
      { scenario: 's11-aiproxy-real' },
    );
    expect(summary.scenario).toBe('s11-aiproxy-real');
    expect(summary.providers.map((provider) => provider.provider)).not.toEqual(
      expect.arrayContaining([
        'ocr-somark',
        'ocr-textin',
        'ocr-doc2x',
        'feishu',
        'yuque',
        'dingtalk',
      ]),
    );
  });

  it('accepts one known scenario with JSON output', () => {
    const ready = runProviderInputCli(['--scenario=s11-aiproxy-real', '--json']);
    expect(ready.status).toBe(0);
    const summary = JSON.parse(ready.stdout);
    expect(summary).toMatchObject({
      status: 'READY',
      scenario: 's11-aiproxy-real',
    });
    expect(summary.providers.map((provider: { provider: string }) => provider.provider)).toEqual([
      'mode',
      'aiproxy',
    ]);
  });

  it('rejects empty, duplicate, unknown and unsupported CLI arguments', () => {
    const cases = [
      {
        args: ['--scenario=', '--json'],
        code: 'PROVIDER_SCENARIO_INVALID: scenario must not be empty',
      },
      {
        args: ['--scenario=s11-aiproxy-real', '--scenario=s11-provider-quota', '--json'],
        code: 'PROVIDER_SCENARIO_INVALID: scenario specified more than once',
      },
      {
        args: ['--scenario=s11-unknown-scenario', '--json'],
        code: 'PROVIDER_SCENARIO_INVALID: unknown scenario s11-unknown-scenario',
      },
      {
        args: ['--unsupported'],
        code: 'PROVIDER_INPUT_INVALID: unsupported argument --unsupported',
      },
    ];
    for (const testCase of cases) {
      const result = runProviderInputCli(testCase.args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(testCase.code);
    }
  });

  it('passes the scenario through with or without a pnpm separator', () => {
    expect(requestedScenario(['s11-aiproxy-real'])).toBe('s11-aiproxy-real');
    expect(requestedScenario(['--', 's11-aiproxy-real'])).toBe('s11-aiproxy-real');
  });
});
