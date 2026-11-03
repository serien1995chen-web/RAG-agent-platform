import { describe, expect, it } from 'vitest';
import { ConfigValidationException } from '../../src/shared/config/config-error';
import {
  S5AiproxyConfigSchema,
  loadS5AiproxyConfig,
} from '../../src/shared/config/s5-aiproxy-config';

describe('S5-CFG-01 AIProxy configuration', () => {
  it('accepts compose, external and openai combinations without resolving secrets', () => {
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
      providerOnly: null,
      rerankProtocol: 'openai',
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

    const openai = loadS5AiproxyConfig({
      AIPROXY_MODE: 'openai',
      AIPROXY_BASE_URL: 'https://tokendance.space/gateway/v1',
      AIPROXY_API_TOKEN_REF: 'env:TOKENDANCE_API_TOKEN',
      KB_EXTERNAL_MODEL_MODE: 'real',
      AIPROXY_API_TOKEN: 'fake-local-token',
      AIPROXY_PROVIDER_ONLY: 'alibaba',
      AIPROXY_RERANK_PROTOCOL: 'alibaba-native',
    });
    expect(openai).toMatchObject({
      mode: 'openai',
      baseUrl: 'https://tokendance.space/gateway/v1',
      postgresUriRef: null,
      modelMode: 'real',
      providerOnly: ['alibaba'],
      rerankProtocol: 'alibaba-native',
    });
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
        AIPROXY_MODE: 'openai',
        AIPROXY_API_TOKEN_REF: 'env:TOKENDANCE_API_TOKEN',
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
        providerOnly: null,
        rerankProtocol: 'openai',
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

  it('derives TokenDance Alibaba routing without adding new required inputs', () => {
    const config = loadS5AiproxyConfig({
      AIPROXY_MODE: 'openai',
      AIPROXY_BASE_URL: 'https://tokendance.space/gateway/v1',
      KB_EXTERNAL_MODEL_MODE: 'real',
      AIPROXY_API_TOKEN: 'fake-local-token',
    });
    expect(config.providerOnly).toEqual(['alibaba']);
    expect(config.rerankProtocol).toBe('alibaba-native');
  });

  it('requires a non-empty token for openai real mode', () => {
    expect(() =>
      loadS5AiproxyConfig({
        AIPROXY_MODE: 'openai',
        AIPROXY_BASE_URL: 'https://tokendance.space/gateway/v1',
        AIPROXY_API_TOKEN_REF: 'env:TOKENDANCE_API_TOKEN',
        KB_EXTERNAL_MODEL_MODE: 'real',
      }),
    ).toThrow(ConfigValidationException);
  });
});
