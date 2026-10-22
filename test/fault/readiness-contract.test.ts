import { beforeEach, describe, expect, it, vi } from 'vitest';

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
