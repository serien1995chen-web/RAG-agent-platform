import axios, { type AxiosError, type AxiosRequestConfig } from 'axios';
import type {
  S5ModelAdapterResponse,
  S5ModelInvocation,
  S5ModelInvocationAdapterPort,
  S5ModelType,
} from '../application/s5-model-gateway.port';
import { S5ModelTransportError } from '../application/s5-model-gateway.port';
import { embeddingInputItems } from '../application/s5-model-gateway';
import { parseModelResponse } from './s5-model-response.schema';

export interface S5HttpResponse<T = unknown> {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  data: T;
}

export interface S5HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  responseType?: 'json' | 'arraybuffer';
}

export interface S5HttpTransportPort {
  request<T = unknown>(input: S5HttpRequest): Promise<S5HttpResponse<T>>;
}

export class AxiosS5HttpTransport implements S5HttpTransportPort {
  async request<T = unknown>(input: S5HttpRequest): Promise<S5HttpResponse<T>> {
    const config: AxiosRequestConfig = {
      method: input.method,
      url: input.url,
      headers: input.headers,
      data: input.body,
      timeout: input.timeoutMs,
      responseType: input.responseType ?? 'json',
      validateStatus: () => true,
      transitional: { clarifyTimeoutError: true },
    };
    try {
      const response = await axios.request<T>(config);
      return {
        status: response.status,
        headers: response.headers as Record<string, string | string[] | undefined>,
        data: response.data,
      };
    } catch (error) {
      const axiosError = error as AxiosError;
      if (
        axiosError.code === 'ECONNABORTED' ||
        axiosError.code === 'ETIMEDOUT' ||
        axiosError.name === 'TimeoutError'
      ) {
        throw new S5ModelTransportError('timeout', null, null, 'aiproxy_timeout');
      }
      throw new S5ModelTransportError('provider', null, null, 'aiproxy_unavailable');
    }
  }
}

export function joinAiproxyUrl(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  url.pathname = basePath.endsWith('/v1')
    ? `${basePath}${suffix.replace(/^\/v1/, '')}`
    : `${basePath}/v1${suffix.replace(/^\/v1/, '')}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

const ENDPOINT_BY_KIND: Record<S5ModelType, string> = {
  llm: '/v1/chat/completions',
  vlm: '/v1/chat/completions',
  embedding: '/v1/embeddings',
  rerank: '/v1/rerank',
  stt: '/v1/audio/transcriptions',
  tts: '/v1/audio/speech',
};

const TIMEOUT_BY_KIND: Record<S5ModelType, number> = {
  llm: 120_000,
  vlm: 120_000,
  embedding: 60_000,
  rerank: 30_000,
  stt: 120_000,
  tts: 60_000,
};

function formDataOf(input: Extract<S5ModelInvocation, { kind: 'stt' }>): FormData {
  const form = new FormData();
  form.append('model', input.modelId);
  form.append(
    'file',
    new Blob([new Uint8Array(input.audio).buffer], { type: input.mimeType }),
    `audio.${input.mimeType.split('/')[1] ?? 'bin'}`,
  );
  return form;
}

function vlmMessages(input: Extract<S5ModelInvocation, { kind: 'vlm' }>): unknown[] {
  const imageParts = input.imageUrls.map((url) => ({
    type: 'image_url',
    image_url: { url },
  }));
  const messages = input.messages.map((message) => {
    if (typeof message !== 'object' || message === null) return message;
    return { ...(message as Record<string, unknown>) };
  });
  const last = messages.at(-1);
  if (
    typeof last === 'object' &&
    last !== null &&
    (last as Record<string, unknown>).role === 'user'
  ) {
    const user = last as Record<string, unknown>;
    const content = Array.isArray(user.content)
      ? [...user.content, ...imageParts]
      : [{ type: 'text', text: String(user.content ?? '') }, ...imageParts];
    messages[messages.length - 1] = { ...user, content };
    return messages;
  }
  return [...messages, { role: 'user', content: imageParts }];
}

function bodyOf(input: S5ModelInvocation): unknown {
  switch (input.kind) {
    case 'llm':
      return {
        model: input.modelId,
        messages: input.messages,
        max_tokens: input.maxOutputTokens,
      };
    case 'vlm':
      return {
        model: input.modelId,
        messages: vlmMessages(input),
        ...(input.maxOutputTokens === undefined ? {} : { max_tokens: input.maxOutputTokens }),
      };
    case 'embedding':
      return { model: input.modelId, input: embeddingInputItems(input) };
    case 'rerank':
      return {
        model: input.modelId,
        query: input.query,
        documents: input.candidates,
      };
    case 'stt':
      return formDataOf(input);
    case 'tts':
      return { model: input.modelId, input: input.text, voice: input.voice };
  }
}

function retryAfterMs(response: S5HttpResponse): number | null {
  const raw = response.headers['retry-after'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 5_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(Math.max(date - Date.now(), 0), 5_000) : null;
}

function responseDurationSeconds(response: S5HttpResponse): number | undefined {
  const raw =
    response.headers['x-audio-duration-seconds'] ??
    response.headers['x-duration-seconds'] ??
    response.headers['content-duration'];
  const value = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export class S5AiproxyHttpAdapter implements S5ModelInvocationAdapterPort {
  constructor(
    private readonly input: {
      baseUrl: string;
      token: string;
      transport: S5HttpTransportPort;
    },
  ) {}

  async invoke<T = unknown>(
    invocation: S5ModelInvocation,
    context: {
      workspaceId: string;
      requestId: string;
      traceId: string;
    } = { workspaceId: 'runtime', requestId: 'runtime', traceId: 'runtime' },
  ): Promise<S5ModelAdapterResponse<T>> {
    const response = await this.input.transport.request<T>({
      method: 'POST',
      url: joinAiproxyUrl(this.input.baseUrl, ENDPOINT_BY_KIND[invocation.kind]),
      headers: {
        Authorization: `Bearer ${this.input.token}`,
        'Content-Type': invocation.kind === 'stt' ? 'multipart/form-data' : 'application/json',
        Accept: invocation.kind === 'tts' ? 'audio/mpeg' : 'application/json',
        'X-Workspace-Id': context.workspaceId,
        'X-Request-Id': context.requestId,
        'X-Trace-Id': context.traceId,
      },
      body: bodyOf(invocation),
      timeoutMs: TIMEOUT_BY_KIND[invocation.kind],
      responseType: invocation.kind === 'tts' ? 'arraybuffer' : 'json',
    });
    if (response.status === 401 || response.status === 403) {
      throw new S5ModelTransportError('auth', response.status, null, 'aiproxy_auth_rejected');
    }
    if (response.status === 429) {
      throw new S5ModelTransportError(
        'rate_limit',
        response.status,
        retryAfterMs(response),
        'aiproxy_rate_limited',
      );
    }
    if (response.status >= 500) {
      throw new S5ModelTransportError(
        'provider',
        response.status,
        retryAfterMs(response),
        'aiproxy_unavailable',
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new S5ModelTransportError('contract', response.status, null, 'aiproxy_http_error');
    }
    try {
      const parsed = parseModelResponse({
        kind: invocation.kind,
        data: response.data,
        ...(invocation.kind === 'embedding' ? { dimension: invocation.dimension } : {}),
        ...(invocation.kind === 'tts'
          ? {
              inputText: invocation.text,
              durationSeconds: responseDurationSeconds(response),
            }
          : {}),
      });
      return {
        data: parsed.data as T,
        status: response.status,
        quantity: parsed.quantity,
        usage: parsed.usage,
      };
    } catch (error) {
      const kind =
        error instanceof Error && error.message === 'embedding_dimension_mismatch'
          ? 'contract'
          : 'contract';
      throw new S5ModelTransportError(
        kind,
        response.status,
        null,
        error instanceof Error ? error.message : 'model_response_invalid',
      );
    }
  }
}

export class S5MockAiproxyTransport implements S5HttpTransportPort {
  async request<T = unknown>(input: S5HttpRequest): Promise<S5HttpResponse<T>> {
    const path = new URL(input.url).pathname;
    if (path.endsWith('/embeddings')) {
      const body = input.body as { model: string; input: Array<Record<string, unknown>> };
      const dimension = Number(/-(\d+)$/.exec(body.model)?.[1] ?? 0);
      return {
        status: 200,
        headers: {},
        data: {
          data: body.input.map((item, index) => ({
            index,
            embedding: Array.from({ length: dimension }, (_, vectorIndex) => {
              const stable = JSON.stringify(item) || 'item';
              const byte = Buffer.from(stable, 'utf8')[(index + vectorIndex) % stable.length] ?? 0;
              return vectorIndex === 0 ? 1 : ((byte - 127.5) / 127.5) * 0.01;
            }),
          })),
          usage: { prompt_tokens: 0, total_tokens: 0 },
        } as T,
      };
    }
    if (path.endsWith('/chat/completions')) {
      const body = input.body as { messages?: unknown[] };
      const content = JSON.stringify(body.messages ?? []);
      const imageInput = content.includes('"image_url"');
      const plannerInput = content.includes('Return only a JSON object with queries');
      return {
        status: 200,
        headers: {},
        data: {
          choices: [
            {
              message: {
                content: imageInput
                  ? JSON.stringify({
                      caption: `mock caption ${Buffer.from(content).toString('base64url').slice(0, 12)}`,
                    })
                  : plannerInput
                    ? JSON.stringify({ queries: ['mock deep query'], sufficient: true })
                    : 'mock response',
              },
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0 },
        } as T,
      };
    }
    if (path.endsWith('/audio/speech')) {
      return {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
        data: new Uint8Array() as T,
      };
    }
    return {
      status: 200,
      headers: {},
      data: {
        text: path.endsWith('/audio/transcriptions') ? 'mock transcript' : 'mock',
        results: [],
      } as T,
    };
  }
}
