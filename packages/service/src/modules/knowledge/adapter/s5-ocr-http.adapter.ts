import axios, { type AxiosError } from 'axios';
import { z } from 'zod';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type {
  OcrCredentialProfilePort,
  OcrProviderPort,
  S5OcrHttpRequest,
  S5OcrHttpResponse,
  S5OcrHttpTransportPort,
  S5OcrRequest,
  S5OcrProviderResult,
  S5ProviderUsage,
} from '../application/s5-ocr-ports';
import { S5OcrProviderError as ProviderError } from '../application/s5-ocr-ports';
import { parseOcrResponse } from './s5-ocr-response.schema';

export class S5OcrHttpTimeoutError extends Error {
  constructor() {
    super('OCR provider request timed out.');
    this.name = 'S5OcrHttpTimeoutError';
  }
}

export class AxiosS5OcrHttpTransport implements S5OcrHttpTransportPort {
  async request<T = unknown>(input: S5OcrHttpRequest): Promise<S5OcrHttpResponse<T>> {
    try {
      const response = await axios.request<T>({
        method: input.method,
        url: input.url,
        headers: input.headers,
        data: input.body,
        timeout: input.timeoutMs,
        responseType: input.responseType ?? 'json',
        validateStatus: () => true,
        transitional: { clarifyTimeoutError: true },
      });
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
        throw new S5OcrHttpTimeoutError();
      }
      throw new ProviderError('provider', null, [], true, false);
    }
  }
}

const PreuploadSchema = z
  .object({
    uploadUrl: z.string().url(),
    statusUrl: z.string().url(),
  })
  .passthrough();

function providerPath(provider: S5OcrRequest['config']['provider']): string {
  if (provider === 'somark') return '/parse/sync';
  if (provider === 'textin') return '/pdf_to_markdown';
  if (provider === 'doc2x') return '/parse/preupload';
  return '/ocr';
}

function appendPath(endpoint: string, path: string): string {
  const url = new URL(endpoint);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${path}`;
  return url.toString();
}

function requestUsage(provider: string, status: number | null): S5ProviderUsage {
  return { provider, unit: 'request', quantity: 1, status };
}

function classifyStatus(status: number, usage: S5ProviderUsage[]): ProviderError | null {
  if (status === 401 || status === 403)
    return new ProviderError('auth', status, usage, false, false);
  if (status === 402) return new ProviderError('quota', status, usage, false, false);
  if (status === 429) return new ProviderError('rate_limit', status, usage, true, false);
  if (status >= 500) return new ProviderError('provider', status, usage, true, false);
  if (status < 200 || status >= 300)
    return new ProviderError('provider', status, usage, false, false);
  return null;
}

function multipartFile(input: S5OcrRequest): FormData {
  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array(input.bytes).buffer], { type: input.mimeType }),
    input.fileName,
  );
  return form;
}

export class S5OcrHttpAdapter implements OcrProviderPort {
  constructor(
    private readonly input: {
      profiles: OcrCredentialProfilePort;
      transport: S5OcrHttpTransportPort;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {}

  async parse(request: S5OcrRequest, _context: TenantContext): Promise<S5OcrProviderResult> {
    const config = request.config;
    const profile = await this.input.profiles.resolve(config.credentialProfileId, config.provider);
    const usage: S5ProviderUsage[] = [];
    const call = async <T = unknown>(
      input: Omit<S5OcrHttpRequest, 'timeoutMs'> & { timeoutMs?: number },
    ) => {
      try {
        const response = await this.input.transport.request<T>({
          ...input,
          timeoutMs: input.timeoutMs ?? request.timeoutMs,
        });
        usage.push(requestUsage(config.provider, response.status));
        const failure = classifyStatus(response.status, usage);
        if (failure) throw failure;
        return response;
      } catch (error) {
        if (error instanceof S5OcrHttpTimeoutError) {
          usage.push(requestUsage(config.provider, null));
          throw new ProviderError('timeout', null, usage, true, false);
        }
        throw error;
      }
    };

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Request-Id': request.requestId,
      'X-Trace-Id': request.traceId,
    };
    let body: Uint8Array | FormData;
    const url = appendPath(profile.endpoint, providerPath(config.provider));
    switch (config.provider) {
      case 'sangfor': {
        const form = multipartFile(request);
        form.append('keep_header_footer', String(config.keepHeaderFooter));
        form.append('keep_appendix', String(config.keepAppendix));
        form.append('image_analysis', String(config.imageAnalysis));
        form.append('chart_analysis', String(config.chartAnalysis));
        body = form;
        headers.Authorization = `Bearer ${profile.credentials.token ?? ''}`;
        break;
      }
      case 'somark': {
        body = multipartFile(request);
        headers['X-API-Key'] = profile.credentials.apiKey ?? '';
        break;
      }
      case 'textin': {
        body = request.bytes;
        headers['Content-Type'] = 'application/pdf';
        headers['x-ti-app-id'] = profile.credentials.appId ?? '';
        headers['x-ti-secret-code'] = profile.credentials.secretCode ?? '';
        break;
      }
      case 'doc2x': {
        const bodyRecord = {
          fileName: request.fileName,
          mimeType: request.mimeType,
        };
        const preupload = await call({
          method: 'POST',
          url,
          headers: {
            ...headers,
            'Content-Type': 'application/json',
            Authorization: `Bearer ${profile.credentials.apiKey ?? ''}`,
          },
          body: new TextEncoder().encode(JSON.stringify(bodyRecord)),
        });
        const parsedPreupload = PreuploadSchema.safeParse(preupload.data);
        if (!parsedPreupload.success) {
          throw new ProviderError('contract', preupload.status, usage, false, true);
        }
        await call({
          method: 'PUT',
          url: parsedPreupload.data.uploadUrl,
          headers: { ...headers, 'Content-Type': request.mimeType },
          body: request.bytes,
        });
        const deadline = Date.now() + request.timeoutMs;
        while (Date.now() < deadline) {
          const statusResponse = await call({
            method: 'GET',
            url: parsedPreupload.data.statusUrl,
            headers: {
              ...headers,
              Authorization: `Bearer ${profile.credentials.apiKey ?? ''}`,
            },
          });
          const record = statusResponse.data as { status?: unknown; error?: unknown };
          if (record.status === 'success') {
            try {
              const result = parseOcrResponse('doc2x', statusResponse.data, {
                status: statusResponse.status,
              });
              return {
                ...result,
                usage: [...usage, ...result.usage],
                requestEvidence: {
                  ...result.requestEvidence,
                  requests: usage.length,
                },
              };
            } catch {
              throw new ProviderError('contract', statusResponse.status, usage, false, true);
            }
          }
          if (record.status === 'failed') {
            throw new ProviderError('provider', statusResponse.status, usage, false, false);
          }
          await (this.input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(
            config.pollIntervalMs,
          );
        }
        throw new ProviderError('timeout', null, usage, true, false);
      }
    }
    try {
      const response = await call({
        method: 'POST',
        url,
        headers: {
          ...headers,
          ...(config.provider === 'textin' ? {} : { 'Content-Type': 'multipart/form-data' }),
        },
        body,
      });
      const result = parseOcrResponse(config.provider, response.data, {
        status: response.status,
      });
      return {
        ...result,
        usage: result.usage,
        requestEvidence: {
          ...result.requestEvidence,
          requests: usage.length,
        },
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('contract', null, usage, false, true);
    }
  }
}
