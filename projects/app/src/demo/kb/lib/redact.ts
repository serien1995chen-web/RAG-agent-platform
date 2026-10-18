/**
 * 脱敏：只保留可复核信息，不把凭据写进 sessionStorage 或导出文件。
 * 规则来源：修复任务 §11.4 / §8.1。
 */

const SENSITIVE_KEY = /(authorization|cookie|set-cookie|token|secret|password|signature|credential|apikey|api_key)/i;

const REDACTED = '[REDACTED]';

function redactUrl(value: string): string {
  try {
    const url = new URL(value, 'http://placeholder.local');
    if (!/^https?:$/.test(url.protocol)) return value;
    let changed = false;
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_KEY.test(key)) {
        url.searchParams.set(key, REDACTED);
        changed = true;
      }
    }
    if (!changed) return value;
    return url.toString().replace('http://placeholder.local', '');
  } catch {
    return value;
  }
}

export function redactValue(input: unknown, depth = 0): unknown {
  if (depth > 8) return '[DEPTH-LIMIT]';
  if (input === null || input === undefined) return input;
  if (typeof input === 'string') return redactUrl(input);
  if (typeof input !== 'object') return input;
  if (Array.isArray(input)) return input.map((item) => redactValue(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = redactValue(value, depth + 1);
  }
  return out;
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactUrl(value);
  }
  return out;
}

export const MAX_BODY_BYTES = 64 * 1024;

export function truncateBody(value: unknown): { value: unknown; truncated: boolean } {
  let json: string;
  try {
    json = JSON.stringify(value ?? null);
  } catch {
    return { value: '[UNSERIALIZABLE]', truncated: true };
  }
  if (json === undefined) return { value: null, truncated: false };
  if (json.length <= MAX_BODY_BYTES) return { value, truncated: false };
  return { value: `${json.slice(0, MAX_BODY_BYTES)}…`, truncated: true };
}
