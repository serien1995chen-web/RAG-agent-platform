import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { loadKnowledgeRuntimeConfig } from '../../packages/service/src/shared/config/knowledge-runtime-config';

const readiness = vi.hoisted(() => vi.fn());

vi.mock('../../projects/app/src/runtime/knowledge-runtime', () => ({
  getKnowledgeApiRuntime: async () => ({ readiness }),
}));

import readyHandler from '../../projects/app/src/pages/api/readyz';

type Request = Parameters<typeof readyHandler>[0];
type Response = Parameters<typeof readyHandler>[1];

function responseRecorder(): {
  response: Response;
  statusCode: () => number;
  body: () => unknown;
} {
  let statusCode = 200;
  let body: unknown;
  const response = {
    setHeader() {
      return response;
    },
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(value: unknown) {
      body = value;
      return response;
    },
  } as unknown as Response;
  return {
    response,
    statusCode: () => statusCode,
    body: () => body,
  };
}

function request(): Request {
  return {
    method: 'GET',
    url: '/readyz',
    headers: {},
  } as Request;
}

beforeEach(() => {
  readiness.mockReset();
});

describe('readiness failure contract', () => {
  const runtimeEnv = {
    KB_MONGO_URI: 'mongodb://127.0.0.1:27017/knowledge',
    KB_REDIS_URL: 'redis://127.0.0.1:6379',
    KB_PG_URL: 'postgresql://knowledge:knowledge@127.0.0.1:5432/knowledge',
    KB_S3_ENDPOINT: 'http://127.0.0.1:9000',
    KB_S3_BUCKET: 'knowledge',
    KB_S3_ACCESS_KEY_REF: 'knowledge-access',
    KB_S3_SECRET_KEY_REF: 'knowledge-secret',
    API_KEY_HMAC_SECRET_FILE: resolve(import.meta.dirname, '../fixtures/s10/api-key-hmac.secret'),
  };

  it('treats an absent or empty OTLP endpoint as disabled', () => {
    expect(loadKnowledgeRuntimeConfig(runtimeEnv).otelEndpoint).toBeUndefined();
    expect(
      loadKnowledgeRuntimeConfig({
        ...runtimeEnv,
        OTEL_EXPORTER_OTLP_ENDPOINT: '',
      }).otelEndpoint,
    ).toBeUndefined();
  });

  it('accepts and normalizes a configured OTLP endpoint', () => {
    expect(
      loadKnowledgeRuntimeConfig({
        ...runtimeEnv,
        OTEL_EXPORTER_OTLP_ENDPOINT: '  http://collector:4318  ',
      }).otelEndpoint,
    ).toBe('http://collector:4318');
  });

  it('keeps readiness 200 when telemetry alone is degraded', async () => {
    readiness.mockResolvedValue({
      status: 200,
      body: {
        status: 'ok',
        checks: [
          { name: 'mongo', status: 'ok', latencyMs: 1 },
          { name: 'telemetry', status: 'degraded', latencyMs: 0 },
        ],
        timestamp: new Date().toISOString(),
      },
    });
    const recorder = responseRecorder();
    await readyHandler(request(), recorder.response);
    expect(recorder.statusCode()).toBe(200);
    expect(recorder.body()).toMatchObject({
      success: true,
      data: {
        checks: [
          expect.objectContaining({ name: 'mongo', status: 'ok' }),
          expect.objectContaining({ name: 'telemetry', status: 'degraded' }),
        ],
      },
    });
  });

  it('returns a 503 Problem when a real dependency probe is down', async () => {
    readiness.mockResolvedValue({
      status: 503,
      body: {
        status: 'down',
        checks: [{ name: 'postgres', status: 'down', latencyMs: 5 }],
        timestamp: new Date().toISOString(),
      },
    });
    const recorder = responseRecorder();
    await readyHandler(request(), recorder.response);
    expect(recorder.statusCode()).toBe(503);
    expect(recorder.body()).toMatchObject({
      success: false,
      error: {
        code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
        details: {
          checks: [{ name: 'postgres', status: 'down', latencyMs: 5 }],
        },
      },
    });
  });

  it('does not fake readiness when runtime bootstrap fails', async () => {
    readiness.mockRejectedValue(new Error('connection refused'));
    const recorder = responseRecorder();
    await readyHandler(request(), recorder.response);
    expect(recorder.statusCode()).toBe(503);
    expect(recorder.body()).toMatchObject({
      success: false,
      error: {
        code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
        details: { dependency: 'runtime' },
      },
    });
  });
});
