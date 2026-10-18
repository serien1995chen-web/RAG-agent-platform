import { randomUUID } from 'node:crypto';

/** ISSUE-007：未知内部错误的可关联事件 ID。 */
export function newErrorEventId(): string {
  return randomUUID();
}

const REDACTIONS: readonly [RegExp, string][] = [
  [/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]'],
  [/(X-Amz-Signature=)[^&\s"']+/gi, '$1[redacted]'],
  [
    /((?:password|passwd|secret|token|accesskey|secretkey|api[_-]?key)\s*[=:]\s*)[^\s,;"'}]+/gi,
    '$1[redacted]',
  ],
  [/\b[A-Fa-f0-9]{32,}\b/g, '[redacted-hex]'],
];

/** 日志值脱敏：命中凭据/签名模式即替换，随后截断，避免日志成为泄露通道。 */
export function sanitizeInternalDetail(value: string, maxLength = 300): string {
  let sanitized = value;
  for (const [pattern, replacement] of REDACTIONS) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  return sanitized.length > maxLength ? `${sanitized.slice(0, maxLength)}...` : sanitized;
}

export interface InternalErrorSummary {
  errorName: string;
  detail: string;
  stackHead: string;
}

/** 只取错误名、脱敏后的消息与前三帧堆栈；不输出完整对象，避免夹带请求上下文。 */
export function describeInternalError(error: unknown): InternalErrorSummary {
  if (!(error instanceof Error)) {
    return {
      errorName: typeof error,
      detail: sanitizeInternalDetail(String(error)),
      stackHead: '',
    };
  }
  const stackHead = (error.stack ?? '')
    .split('\n')
    .slice(0, 3)
    .map((line) => sanitizeInternalDetail(line, 160))
    .join(' | ');
  return {
    errorName: error.name,
    detail: sanitizeInternalDetail(error.message),
    stackHead,
  };
}
