import { randomUUID } from 'node:crypto';
import type { NextApiRequest } from 'next';

export const REQUEST_ID_HEADER = 'x-request-id';

/** requestId 贯穿 trace、日志与响应；非法或缺失时由服务端生成。 */
export function resolveRequestId(request: NextApiRequest): string {
  const header = request.headers[REQUEST_ID_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value === 'string' && value.length > 0 && value.length <= 128) return value;
  return randomUUID();
}
