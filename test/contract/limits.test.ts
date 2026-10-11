import type { NextApiRequest, NextApiResponse } from 'next';
import { describe, expect, it } from 'vitest';
import {
  checkBusinessBytes,
  checkDecompressedBytes,
  checkItemCount,
  checkProxyBytes,
  requestLimitsFromConfig,
  RAW_BODY_TOO_LARGE,
  PAYLOAD_BYTES_EXCEEDED,
} from '../../packages/service/src/shared/http/limits';

const limits = requestLimitsFromConfig({
  maxRequestBodyBytes: 10 * 1024 * 1024,
  maxRawTextBytes: 10 * 1024 * 1024,
  maxPushItems: 200,
});

describe('P4-11 three-layer request limits', () => {
  it('[TEST-API-LIMIT-001][TEST-API-RAW-001] maps config fields into proxy/decompressed/business/item limits', () => {
    expect(limits).toEqual({
      maxRequestBodyBytes: 10 * 1024 * 1024,
      maxDecompressedBytes: 10 * 1024 * 1024,
      maxBusinessBytes: 10 * 1024 * 1024,
      maxItems: 200,
    });
  });

  it('rejects proxy bytes over the raw limit with 501030', () => {
    const decision = checkProxyBytes(limits, limits.maxRequestBodyBytes + 1);
    expect(decision).toMatchObject({ allowed: false, code: RAW_BODY_TOO_LARGE, layer: 'proxy' });
    expect(checkProxyBytes(limits, limits.maxRequestBodyBytes)).toEqual({ allowed: true });
  });

  it('rejects decompressed bytes over the limit with 501030', () => {
    const decision = checkDecompressedBytes(limits, limits.maxDecompressedBytes + 1);
    expect(decision).toMatchObject({
      allowed: false,
      code: RAW_BODY_TOO_LARGE,
      layer: 'decompressed',
    });
  });

  it('rejects business bytes over the limit with 501065', () => {
    const decision = checkBusinessBytes(limits, limits.maxBusinessBytes + 1);
    expect(decision).toMatchObject({
      allowed: false,
      code: PAYLOAD_BYTES_EXCEEDED,
      layer: 'business',
    });
  });

  it('rejects pushData at 201 items with 501030 and accepts 200', () => {
    expect(checkItemCount(limits, 200)).toEqual({ allowed: true });
    expect(checkItemCount(limits, 201)).toMatchObject({
      allowed: false,
      code: RAW_BODY_TOO_LARGE,
      layer: 'items',
      limitItems: 200,
      actualItems: 201,
    });
  });

  it('enforces proxy Content-Length in withApiHandler before the handler runs', async () => {
    const { withApiHandler } = await import('../../projects/app/src/shared/api/with-api-handler');
    let handlerRuns = 0;
    const handler = withApiHandler(async () => {
      handlerRuns += 1;
    });
    let status = 200;
    let body: unknown = null;
    const response = {
      setHeader: () => response,
      status(code: number) {
        status = code;
        return response;
      },
      json(value: unknown) {
        body = value;
        return response;
      },
    } as unknown as NextApiResponse;
    const request = {
      method: 'POST',
      url: '/api/core/dataset/data/pushData',
      headers: { 'content-length': String(limits.maxRequestBodyBytes + 1) },
      body: {},
      query: {},
    } as unknown as NextApiRequest;
    await handler(request, response);
    expect(handlerRuns).toBe(0);
    expect(status).toBe(413);
    expect((body as { code?: number }).code).toBe(RAW_BODY_TOO_LARGE);
  });

  it('does not rewrite empty-import success semantics', () => {
    // 空导入不是超限：0 字节/0 条目必须保持 allowed，由路由返回 insertLen=0/ready。
    expect(checkBusinessBytes(limits, 0)).toEqual({ allowed: true });
    expect(checkItemCount(limits, 0)).toEqual({ allowed: true });
  });
});
