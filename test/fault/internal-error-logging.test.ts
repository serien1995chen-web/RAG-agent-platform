import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  records: [] as { event: string; fields: Record<string, unknown> }[],
}));

vi.mock('../../projects/app/src/runtime/health', () => ({
  getRuntime: async () => ({
    clients: {
      logger: {
        log: (event: string, fields: Record<string, unknown>) => {
          state.records.push({ event, fields });
        },
      },
    },
  }),
}));

vi.mock('../../projects/app/src/runtime/auth', () => ({
  authenticateRequest: async () => ({
    context: {
      requestId: 'req-1',
      tenant: { teamId: 't', tmbId: 'u', authType: 'token', isRoot: false },
      permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
    },
    subject: { teamId: 't', tmbId: 'u' },
  }),
}));

const { withApiHandler } = await import('../../projects/app/src/shared/api/with-api-handler');

function makeResponse() {
  const captured: { status?: number; body?: Record<string, unknown> } = {};
  const response = {
    setHeader: () => response,
    status(code: number) {
      captured.status = code;
      return response;
    },
    json(body: Record<string, unknown>) {
      captured.body = body;
      return response;
    },
  } as unknown as NextApiResponse;
  return { response, captured };
}

const request = {
  method: 'POST',
  url: '/api/core/dataset/audit-boom',
  headers: {},
  query: {},
  body: {},
} as unknown as NextApiRequest;

/**
 * ISSUE-007：未知内部错误必须落结构化日志并带 errorEventId，
 * 响应体仍保持脱敏（无堆栈）。
 */
describe('internal error logging (ISSUE-007)', () => {
  beforeEach(() => {
    state.records.length = 0;
  });

  it('logs a redacted structured record and returns a sanitized 501998 with errorEventId', async () => {
    const handler = withApiHandler(async () => {
      throw new TypeError('boom Bearer abc.def.ghi token=super-secret');
    });
    const { response, captured } = makeResponse();

    await handler(request, response);

    expect(captured.status).toBe(500);
    expect(captured.body?.code).toBe(501998);
    expect(JSON.stringify(captured.body)).not.toContain('super-secret');
    expect(JSON.stringify(captured.body)).not.toMatch(/at .*\.ts:\d+/);

    const record = state.records.find((item) => item.event === 'api.internal_error');
    expect(record).toBeDefined();
    expect(record?.fields.errorEventId).toBe(
      (captured.body?.params as Record<string, unknown>)?.errorEventId,
    );
    expect(record?.fields.errorName).toBe('TypeError');
    const serialized = JSON.stringify(record?.fields);
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('abc.def.ghi');
  });
});
