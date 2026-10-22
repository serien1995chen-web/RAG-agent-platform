import { randomUUID } from 'node:crypto';
import type { NextApiRequest } from 'next';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const TRACE_PARENT_PATTERN = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i;

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function resolveRequestIdentity(request: NextApiRequest): {
  requestId: string;
  traceId: string;
} {
  const suppliedRequestId = firstHeader(request.headers['x-request-id'])?.trim();
  const requestId =
    suppliedRequestId && REQUEST_ID_PATTERN.test(suppliedRequestId)
      ? suppliedRequestId
      : randomUUID();
  const traceParent = firstHeader(request.headers.traceparent)?.trim();
  const traceId = traceParent?.match(TRACE_PARENT_PATTERN)?.[1] ?? randomUUID().replaceAll('-', '');
  return { requestId, traceId };
}

export function requestPathname(request: NextApiRequest): string {
  const raw = request.url ?? '/';
  return (raw.split('?')[0] ?? raw).replace(/^\/api(?=\/)/, '') || '/';
}
