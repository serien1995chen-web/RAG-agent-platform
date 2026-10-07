import { describe, expect, it } from 'vitest';
import { ApiErrorException } from '../../packages/contracts/src/index';
import {
  assertMockModeAllowed,
  judgeDependencyVersion,
} from '../../packages/service/src/shared/config/dependency-baseline';
import {
  loadConfigFromEnv,
  validateStartupConfig,
} from '../../packages/service/src/shared/config/index';

const baseEnv = {
  NODE_ENV: 'test',
  APP_WORKER_MODE: 'all',
  KB_INSTANCE_ID: 'test-instance',
  KB_DEPENDENCY_BASELINE_ID: 'kb-baseline-6.1',
  KB_VERSION_CHECK_POLICY: 'strict',
  KB_MONGO_URI: 'mongodb://127.0.0.1:27017/kb',
  KB_REDIS_URL: 'redis://127.0.0.1:6379',
  KB_PG_URL: 'postgresql://kb:kb@127.0.0.1:5432/kb',
  KB_S3_ENDPOINT: 'http://127.0.0.1:9000',
  KB_S3_REGION: 'us-east-1',
  KB_S3_BUCKET: 'kb',
  KB_S3_ACCESS_KEY_REF: 'env:KB_S3_ACCESS_KEY',
  KB_S3_SECRET_KEY_REF: 'env:KB_S3_SECRET_KEY',
  KB_CONNECT_TIMEOUT_MS: '5000',
  KB_REQUEST_TIMEOUT_MS: '5000',
  KB_MONGO_POOL_SIZE: '10',
  KB_REDIS_CONNECTIONS: '10',
  KB_PG_POOL_SIZE: '10',
  KB_S3_CONCURRENCY: '4',
  KB_PROVIDER_CONCURRENCY: '4',
  KB_BATCH_SIZE: '100',
  KB_QUEUE_CONCURRENCY: '4',
  KB_PROVIDER_TIMEOUT_MS: '1000',
  KB_PROVIDER_MAX_RETRIES: '3',
} satisfies Record<string, string>;

describe('启动配置与依赖基线（6.6-6.9 / DEPLOY-MODE）', () => {
  it('loads a valid config with mock defaults and disabled index cleanup', () => {
    const config = loadConfigFromEnv(baseEnv);
    expect(config.externalMockMode).toEqual({
      auth: 'mock',
      model: 'mock',
      capacity: 'mock',
      pdfProvider: 'mock',
      backup: 'mock',
    });
    expect(config.mongoDeprecatedIndexCleanup).toBe(false);
  });

  it('accepts explicit mock modes and the deprecated-index cleanup flag', () => {
    const config = loadConfigFromEnv({
      ...baseEnv,
      KB_EXTERNAL_MOCK_MODE: JSON.stringify({ model: 'real' }),
      KB_MONGO_DEPRECATED_INDEX_CLEANUP: 'true',
    });
    expect(config.externalMockMode.model).toBe('real');
    expect(config.externalMockMode.auth).toBe('mock');
    expect(config.mongoDeprecatedIndexCleanup).toBe(true);
  });

  it('rejects unknown baselines, illegal values and out-of-range capacity with exit code 20', () => {
    expect(
      validateStartupConfig({ ...baseEnv, KB_DEPENDENCY_BASELINE_ID: 'kb-baseline-9.9' }),
    ).toMatchObject({ ok: false, exitCode: 20 });
    expect(
      validateStartupConfig({
        ...baseEnv,
        NODE_ENV: 'production',
        KB_VERSION_CHECK_POLICY: 'offline',
      }),
    ).toMatchObject({ ok: false, exitCode: 20 });
    expect(
      validateStartupConfig({
        ...baseEnv,
        NODE_ENV: 'production',
        KB_ALLOW_RUNTIME_OVERRIDE: 'true',
      }),
    ).toMatchObject({ ok: false, exitCode: 20 });
    expect(
      validateStartupConfig({ ...baseEnv, KB_MONGO_DEPRECATED_INDEX_CLEANUP: 'maybe' }),
    ).toMatchObject({ ok: false, exitCode: 20 });
    expect(validateStartupConfig({ ...baseEnv, KB_EXTERNAL_MOCK_MODE: '{not-json' })).toMatchObject(
      { ok: false, exitCode: 20 },
    );
    expect(validateStartupConfig({ ...baseEnv, KB_PROVIDER_MAX_RETRIES: '99' })).toMatchObject({
      ok: false,
      exitCode: 20,
    });
    expect(validateStartupConfig({ ...baseEnv, KB_MONGO_POOL_SIZE: '-1' })).toMatchObject({
      ok: false,
      exitCode: 20,
    });
  });

  it('allows the offline policy only in whitelisted environments', () => {
    expect(
      validateStartupConfig({
        ...baseEnv,
        NODE_ENV: 'development',
        KB_VERSION_CHECK_POLICY: 'offline',
      }).ok,
    ).toBe(true);
  });

  it('guards production mock traffic with 501063', () => {
    let caught: unknown;
    try {
      assertMockModeAllowed({
        dependency: 'model',
        mode: 'mock',
        environment: 'production',
        requestId: 'req-mock',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiErrorException);
    expect((caught as ApiErrorException).error).toMatchObject({
      code: 501063,
      params: { dependency: 'model', environment: 'production' },
    });

    expect(() =>
      assertMockModeAllowed({
        dependency: 'model',
        mode: 'mock',
        environment: 'test',
        requestId: 'req-ok',
      }),
    ).not.toThrow();
  });

  it('maps version verdicts by policy', () => {
    expect(judgeDependencyVersion('5.0.32', '5.0.32', 'strict')).toBe('ok');
    expect(judgeDependencyVersion('5.0.31', '5.0.32', 'strict')).toBe('reject');
    expect(judgeDependencyVersion('5.0.31', '5.0.32', 'degraded')).toBe('degraded');
    expect(judgeDependencyVersion('7.2.4', '7.2-alpine', 'strict')).toBe('ok');
    expect(judgeDependencyVersion('0.8.0', '0.8.0-pg15', 'strict')).toBe('ok');
    expect(judgeDependencyVersion(null, '5.0.32', 'strict')).toBe('reject');
  });
});
