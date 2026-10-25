import type { SafeAttributes, SafeTelemetryValue } from './types';

/** 唯一值级敏感规则源，供日志、Span 和 metric 共用。 */
export const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /(?:mongodb(?:\+srv)?|postgres(?:ql)?|redis|rediss|amqp|amqps):\/\//i,
  /https?:\/\/[^/\s:@]+:[^/\s@]+@/i,
  /[?&](?:x-amz-signature|x-amz-credential|signature|sig|token|access_token)=/i,
  /\b(?:kb_console_session|session|authorization|cookie|token)=/i,
  /\b(?:stack|cause):/i,
];

const SAFE_ERROR_TYPE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SAFE_TELEMETRY_EVENT = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const MAX_SAFE_STRING_LENGTH = 256;

export function isSensitiveTelemetryValue(value: string): boolean {
  return SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

export function isSafeTelemetryValue(value: unknown): value is SafeTelemetryValue {
  return (
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' &&
      value.length <= MAX_SAFE_STRING_LENGTH &&
      !isSensitiveTelemetryValue(value))
  );
}

export function sanitizeTelemetryAttributes(
  attributes: Readonly<Record<string, unknown>> | undefined,
  allowedKeys: ReadonlySet<string>,
): { attributes: SafeAttributes; dropped: number } {
  const safe: SafeAttributes = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (!allowedKeys.has(key) || !isSafeTelemetryValue(value)) {
      dropped += 1;
      continue;
    }
    safe[key] = value;
  }
  return { attributes: safe, dropped };
}

export function sanitizeTelemetryEvent(event: unknown): { event: string; dropped: number } {
  if (
    typeof event === 'string' &&
    SAFE_TELEMETRY_EVENT.test(event) &&
    isSafeTelemetryValue(event)
  ) {
    return { event, dropped: 0 };
  }
  return { event: 'knowledge.telemetry.redacted', dropped: 1 };
}

export function safeErrorAttributes(error: unknown, errorCode?: unknown): SafeAttributes {
  const candidateName =
    error instanceof Error
      ? error.name
      : typeof error === 'object' && error !== null && 'name' in error
        ? String(error.name)
        : 'UnknownError';
  const attributes: SafeAttributes = {
    errorType: SAFE_ERROR_TYPE.test(candidateName) ? candidateName : 'UnknownError',
  };
  const candidateCode =
    errorCode ??
    (typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined);
  if (typeof candidateCode === 'string' && SAFE_ERROR_CODE.test(candidateCode)) {
    attributes.errorCode = candidateCode;
  }
  return attributes;
}
