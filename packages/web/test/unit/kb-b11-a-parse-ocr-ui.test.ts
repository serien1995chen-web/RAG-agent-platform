import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildImportParseConfig,
  s5ExternalOcrConfigFormSchema,
} from '../../src/forms/s5-model-parse-form';
import { providerVerificationLabel } from '../../src/components/s5-model-parse-state';

const webRoot = join(import.meta.dirname, '..', '..', 'src');

describe('L1-B11-A PARSE UI provider settings and recovery', () => {
  it('L1-B11-A-PARSE-002-UI01 exposes and submits provider credentials, fallback, image and timeout settings', () => {
    const workspace = readFileSync(join(webRoot, 'product', 'import-workspace.tsx'), 'utf8');
    const providerPanel = readFileSync(
      join(webRoot, 'components', 's5-parse-settings.tsx'),
      'utf8',
    );
    expect(workspace).toContain('S5ParseSettingsPanel');
    expect(workspace).toMatch(/importFiles\([\s\S]*parseConfig\s*:/);
    expect(providerPanel).toContain('timeoutMs');
    expect(providerPanel).toContain('Credential profile');
    expect(providerPanel).toMatch(/Fallback/);
    expect(providerPanel).toMatch(/Images/);
  });

  it('L1-B11-A-PARSE-002-UI02 retains TextIn and Doc2x options without redefining backend defaults in the UI', () => {
    expect(
      s5ExternalOcrConfigFormSchema.safeParse({
        provider: 'textin',
        credentialProfileId: 'env:B11_TEXTIN',
        fallbackProvider: 'liteparse',
        imageHandling: 'upload_to_storage',
        timeoutMs: 30_000,
        parseMode: 'scan',
        removeWatermark: false,
      }).success,
    ).toBe(true);
    expect(
      s5ExternalOcrConfigFormSchema.safeParse({
        provider: 'doc2x',
        credentialProfileId: 'env:B11_DOC2X',
        fallbackProvider: 'none',
        imageHandling: 'drop',
        timeoutMs: 30_000,
        pollIntervalMs: 2_000,
      }).success,
    ).toBe(true);

    const textin = buildImportParseConfig({
      provider: 'textin',
      credentialProfileId: 'env:B11_TEXTIN',
      fallbackProvider: 'liteparse',
      imageHandling: 'upload_to_storage',
      timeoutMs: 30_000,
    });
    expect(textin).toMatchObject({
      credentialProfileId: 'env:B11_TEXTIN',
      timeoutMs: 30_000,
      fallbackProvider: 'liteparse',
      imageHandling: 'upload_to_storage',
    });
  });

  it('L1-B11-A-PARSE-002-UI03 labels mock and unverified providers without claiming real success', () => {
    expect(providerVerificationLabel({ mode: 'mock', verified: true })).toBe('mock');
    expect(providerVerificationLabel({ mode: 'real', verified: false })).toBe('unverified');
    expect(providerVerificationLabel({ mode: 'external', verified: true })).toBe('real');
  });

  it('L1-B11-A-PARSE-001-UI01 keeps user settings when preview or provider validation fails', () => {
    const workspace = readFileSync(join(webRoot, 'product', 'import-workspace.tsx'), 'utf8');
    expect(workspace).not.toMatch(
      /setSubmitError\([^)]*\)[\s\S]{0,120}setParseProvider\('liteparse'\)/,
    );
    expect(workspace).not.toMatch(
      /setSubmitError\([^)]*\)[\s\S]{0,120}setChunkSettingMode\('auto'\)/,
    );
    expect(workspace).toContain('setSubmitError(caught)');
  });
});
