import type { ApiEnvelope, RunEntry } from '../types';
import { redactHeaders, redactValue, truncateBody } from './redact';
import { appendRun, nextSeq } from './run-store';

/**
 * 所有 demo 请求的唯一出口：记录 method/path/status/code/requestId/耗时，
 * 失败不抛出到页面，统一返回信封（修复任务 §11.3）。
 */
export interface DemoFetchInput {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  scenarioId?: string;
  stepId?: string;
  /** 预签名绝对 URL 上传时置 true，不设置 JSON content-type。 */
  raw?: boolean;
  rawBody?: BodyInit;
}

export interface DemoFetchResult<T> {
  entry: RunEntry;
  envelope: ApiEnvelope<T>;
  ok: boolean;
}

function isAbsolute(path: string): boolean {
  return /^https?:\/\//i.test(path);
}

async function readBody(response: Response): Promise<{ parsed: unknown; text: string }> {
  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return { parsed: null, text };
  try {
    return { parsed: JSON.parse(text) as unknown, text };
  } catch {
    return { parsed: null, text };
  }
}

export async function demoFetch<T = unknown>(input: DemoFetchInput): Promise<DemoFetchResult<T>> {
  const startedAt = Date.now();
  const seq = nextSeq();
  const headers: Record<string, string> = { ...(input.headers ?? {}) };
  const absolute = isAbsolute(input.path);
  let body: BodyInit | undefined = input.rawBody;

  if (!input.raw) {
    headers['content-type'] = headers['content-type'] ?? 'application/json';
    if (input.body !== undefined) body = JSON.stringify(input.body);
  }

  let status = 0;
  let code = 0;
  let envelope: ApiEnvelope<T> = { code: 0, data: null };
  let transportError: string | undefined;
  let responseBody: unknown = null;
  let truncated = false;

  try {
    const response = await fetch(absolute ? input.path : input.path, {
      method: input.method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    status = response.status;
    const { parsed, text } = await readBody(response);
    if (parsed && typeof parsed === 'object') {
      envelope = parsed as ApiEnvelope<T>;
      code = typeof envelope.code === 'number' ? envelope.code : 0;
      // 探针类接口直接返回业务对象（无 code 信封），按 HTTP 状态补齐，避免被误判为失败。
      if (code === 0 && status >= 200 && status < 300) {
        envelope = { code: status, data: parsed as T };
        code = status;
      }
      const cut = truncateBody(parsed);
      responseBody = cut.value;
      truncated = cut.truncated;
    } else {
      const cut = truncateBody(text);
      responseBody = cut.value;
      truncated = cut.truncated;
      envelope = {
        code: status,
        data: null,
        messageKey: 'demo.non_json_response',
        message: text.slice(0, 300),
      };
      code = status;
    }
  } catch (error) {
    transportError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    envelope = {
      code: 0,
      data: null,
      messageKey: 'demo.network_error',
      message: transportError,
    };
  }

  const requestBody = truncateBody(redactValue(input.body));
  const entry: RunEntry = {
    seq,
    at: new Date().toISOString(),
    method: input.method,
    path: input.path,
    status,
    code,
    durationMs: Date.now() - startedAt,
    ...(envelope.messageKey ? { messageKey: envelope.messageKey } : {}),
    ...(envelope.params ? { params: envelope.params } : {}),
    ...(envelope.requestId ? { requestId: envelope.requestId } : {}),
    ...(input.body !== undefined ? { requestBody: requestBody.value } : {}),
    ...(responseBody !== null ? { responseBody } : {}),
    ...(requestBody.truncated || truncated ? { truncated: true } : {}),
    ...(input.scenarioId ? { scenarioId: input.scenarioId } : {}),
    ...(input.stepId ? { stepId: input.stepId } : {}),
    ...(transportError ? { transportError } : {}),
  };

  // headers 只用于 cURL 展示，不进入持久化条目（避免凭据落盘）。
  void redactHeaders(headers);
  appendRun(entry);

  const ok = status >= 200 && status < 300 && (envelope.code === 200 || envelope.code === 0);
  return { entry, envelope, ok };
}

export function buildCurl(entry: RunEntry): string {
  const parts = [`curl -X ${entry.method}`, `'${entry.path}'`];
  if (entry.requestBody !== undefined) {
    parts.push(`-H 'content-type: application/json'`);
    parts.push(`-d '${JSON.stringify(entry.requestBody)}'`);
  }
  return parts.join(' \\\n  ');
}
