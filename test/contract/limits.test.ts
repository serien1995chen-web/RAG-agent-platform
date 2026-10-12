import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertBusinessBytes,
  assertContentLength,
  assertDecodedBody,
  assertPushDataBusinessLimits,
  assertRawTextBytes,
  jsonByteLength,
} from '../../packages/service/src/shared/http/limits';
import { withApiHandler } from '../../projects/app/src/shared/api/with-api-handler';

const limitsState = vi.hoisted(() => ({ maxRequestBodyBytes: 10 }));

vi.mock('../../projects/app/src/runtime/config', () => ({
  getAppConfig: () => ({
    datasetRuntime: {
      maxRequestBodyBytes: limitsState.maxRequestBodyBytes,
      maxRawTextBytes: 10,
      maxPushItems: 200,
    },
  }),
}));

function mockPair(input: { method: string; headers?: Record<string, string>; body?: unknown }) {
  const request = {
    method: input.method,
    url: '/api/core/dataset/import',
    headers: { ...(input.headers ?? {}) },
    query: {},
    body: input.body,
  } as unknown as NextApiRequest;
  const response = {
    statusCode: 200,
    body: null as unknown,
    headers: {} as Record<string, unknown>,
    setHeader(name: string, value: unknown) {
      this.headers[name] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  } as unknown as NextApiResponse & {
    statusCode: number;
    body: { code?: number; data?: unknown };
    headers: Record<string, unknown>;
  };
  return { request, response };
}

beforeEach(() => {
  limitsState.maxRequestBodyBytes = 10;
});

describe('TEST-API-LIMIT-001 request limit layers', () => {
  it('rejects an oversized Content-Length before the handler runs', async () => {
    const handler = vi.fn();
    const wrapped = withApiHandler(handler);
    const { request, response } = mockPair({
      method: 'POST',
      headers: { 'content-length': '999' },
      body: { small: true },
    });
    await wrapped(request, response);
    expect(response.statusCode).toBe(413);
    expect(response.body.code).toBe(501065);
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects an oversized decoded body before the handler runs', async () => {
    const handler = vi.fn();
    const wrapped = withApiHandler(handler);
    const { request, response } = mockPair({
      method: 'POST',
      body: { big: 'x'.repeat(100) },
    });
    await wrapped(request, response);
    expect(response.body.code).toBe(501065);
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs the handler for a within-limit request', async () => {
    const handler = vi.fn(async (_request: NextApiRequest, res: NextApiResponse): Promise<void> => {
      res.status(200).json({ code: 200, data: { ok: true } });
    });
    const wrapped = withApiHandler(handler);
    const { request, response } = mockPair({ method: 'POST', body: { a: 1 } });
    await wrapped(request, response);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(200);
  });

  it('reaches the limit layer for bodies above the Next default 1MB', async () => {
    limitsState.maxRequestBodyBytes = 10 * 1024 * 1024;
    const handler = vi.fn(async (_request: NextApiRequest, res: NextApiResponse): Promise<void> => {
      res.status(200).json({ code: 200, data: { ok: true } });
    });
    const wrapped = withApiHandler(handler, { maxRequestBodyBytes: 20 * 1024 * 1024 });
    const { request, response } = mockPair({
      method: 'POST',
      body: { payload: 'x'.repeat(2 * 1024 * 1024) },
    });
    await wrapped(request, response);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(200);
  });
});

describe('TEST-API-RAW-001 and TEST-INGEST-EMPTY-001 business layers', () => {
  it('enforces rawText and business-field byte limits with 501065', () => {
    expect(() => assertRawTextBytes({ bytes: 11, limitBytes: 10, requestId: 'r' })).toThrowError(
      expect.objectContaining({ error: expect.objectContaining({ code: 501065 }) }),
    );
    expect(() => assertBusinessBytes({ bytes: 11, limitBytes: 10, requestId: 'r' })).toThrowError(
      expect.objectContaining({ error: expect.objectContaining({ code: 501065 }) }),
    );
  });

  it('rejects pushData over item count with 501030 and over bytes with 501065', () => {
    expect(() =>
      assertPushDataBusinessLimits({
        items: 201,
        bytes: 1,
        maxItems: 200,
        maxBytes: 10,
        requestId: 'r',
      }),
    ).toThrowError(expect.objectContaining({ error: expect.objectContaining({ code: 501030 }) }));
    expect(() =>
      assertPushDataBusinessLimits({
        items: 1,
        bytes: 11,
        maxItems: 200,
        maxBytes: 10,
        requestId: 'r',
      }),
    ).toThrowError(expect.objectContaining({ error: expect.objectContaining({ code: 501065 }) }));
  });

  it('does not rewrite empty-import success semantics', async () => {
    limitsState.maxRequestBodyBytes = 1024;
    const handler = vi.fn(async (_request: NextApiRequest, res: NextApiResponse): Promise<void> => {
      res.status(200).json({ code: 200, data: { insertLen: 0 } });
    });
    const wrapped = withApiHandler(handler);
    const { request, response } = mockPair({ method: 'POST', body: {} });
    await wrapped(request, response);
    expect(response.statusCode).toBe(200);
    expect((response.body.data as { insertLen: number }).insertLen).toBe(0);
    expect(jsonByteLength({})).toBe(2);
    expect(() =>
      assertContentLength({ headers: {}, limitBytes: 10, requestId: 'r' }),
    ).not.toThrow();
    expect(() => assertDecodedBody({ body: {}, limitBytes: 10, requestId: 'r' })).not.toThrow();
  });
});
