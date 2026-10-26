import { describe, expect, it } from 'vitest';
import { ConfigValidationException } from '../../src/shared/config/config-error';
import {
  S5AiproxyConfigSchema,
  loadS5AiproxyConfig,
} from '../../src/shared/config/s5-aiproxy-config';

describe('S5-CFG-01 AIProxy configuration', () => {
  it('accepts compose mock and real combinations without resolving secrets', () => {
    const mock = loadS5AiproxyConfig({
      AIPROXY_MODE: 'compose',
      AIPROXY_BASE_URL: 'http://aiproxy:3000',
      AIPROXY_API_TOKEN_REF: 'env:AIPROXY_API_TOKEN',
      AIPROXY_POSTGRES_URI_REF: 'env:AIPROXY_POSTGRES_URI',
      KB_EXTERNAL_MODEL_MODE: 'mock',
    });
    expect(mock).toEqual({
      mode: 'compose',
      baseUrl: 'http://aiproxy:3000',
      apiTokenRef: 'env:AIPROXY_API_TOKEN',
      postgresUriRef: 'env:AIPROXY_POSTGRES_URI',
      modelMode: 'mock',
    });

    const real = loadS5AiproxyConfig({
      AIPROXY_MODE: 'external',
      AIPROXY_BASE_URL: 'https://gateway.example.invalid/v1',
      AIPROXY_API_TOKEN_REF: 'env:EXTERNAL_PROXY_TOKEN',
      KB_EXTERNAL_MODEL_MODE: 'real',
      AIPROXY_API_TOKEN: 'fake-local-token',
    });
    expect(real.postgresUriRef).toBeNull();
    expect(real.modelMode).toBe('real');
  });

  it('requires explicit external URL and a compose PostgreSQL reference', () => {
    expect(() =>
      loadS5AiproxyConfig({
        AIPROXY_MODE: 'external',
        AIPROXY_API_TOKEN_REF: 'env:EXTERNAL_PROXY_TOKEN',
        KB_EXTERNAL_MODEL_MODE: 'mock',
      }),
    ).toThrow(ConfigValidationException);
    expect(() =>
      loadS5AiproxyConfig({
        AIPROXY_MODE: 'compose',
        AIPROXY_POSTGRES_URI_REF: 'file:/run/aiproxy-postgres-uri',
      }),
    ).toThrow(ConfigValidationException);
  });

  it('rejects embedded URL credentials and non-env secret references', () => {
    expect(() =>
      S5AiproxyConfigSchema.parse({
        mode: 'external',
        baseUrl: 'https://user:password@example.invalid',
        apiTokenRef: 'file:/run/secret',
        postgresUriRef: null,
        modelMode: 'mock',
      }),
    ).toThrow();
  });

  it('keeps deployment mode independent from provider mode', () => {
    const config = loadS5AiproxyConfig({
      AIPROXY_MODE: 'compose',
      KB_EXTERNAL_MODEL_MODE: 'real',
      AIPROXY_API_TOKEN: 'fake-local-token',
    });
    expect(config.mode).toBe('compose');
    expect(config.modelMode).toBe('real');
  });
});
