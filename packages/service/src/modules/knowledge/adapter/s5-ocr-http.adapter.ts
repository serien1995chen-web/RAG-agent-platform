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
    uploadUrl: z.string().url().optional(),
    statusUrl: z.string().url().optional(),
    data: z
      .object({
        uid: z.string().min(1),
        url: z.string().url(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const SomarkNativeResponseSchema = z
  .object({
    code: z.number().int(),
    data: z
      .object({
        result: z
          .object({
            outputs: z.object({ markdown: z.string().min(1) }).passthrough(),
          })
          .passthrough(),
        metadata: z.object({ page_num: z.number().int().min(1) }).passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

const TextinNativeResponseSchema = z
  .object({
    code: z.number().int(),
    result: z
      .object({
        markdown: z.string().min(1),
        total_page_number: z.number().int().min(1).optional(),
        pages: z.array(z.record(z.string(), z.unknown())).optional(),
      })
      .passthrough(),
  })
  .passthrough();

const Doc2xNativeResponseSchema = z
  .object({
    code: z.union([z.string(), z.number()]).optional(),
    msg: z.string().optional(),
    data: z.record(z.string(), z.unknown()),
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

function textinUrl(endpoint: string): string {
  const url = new URL(appendPath(endpoint, '/pdf_to_markdown'));
  url.searchParams.set('get_image', 'objects');
  url.searchParams.set('image_output_type', 'default');
  url.searchParams.set('parse_mode', 'auto');
  url.searchParams.set('dpi', '144');
  url.searchParams.set('markdown_details', '1');
  url.searchParams.set('table_flavor', 'md');
  url.searchParams.set('paratext_mode', 'none');
  url.searchParams.set('page_details', '0');
  url.searchParams.set('remove_watermark', '1');
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

function classifyBusinessCode(
  provider: S5OcrRequest['config']['provider'],
  data: unknown,
  status: number,
  usage: S5ProviderUsage[],
): ProviderError | null {
  if (!data || typeof data !== 'object' || !('code' in data)) return null;
  const code = (data as { code: unknown }).code;
  const success =
    provider === 'somark'
      ? code === 0
      : provider === 'textin'
        ? code === 200
        : code === 'ok' || code === 'success' || code === 0 || code === 200;
  if (success) return null;
  const normalized = String(code).toLowerCase();
  if (provider === 'somark' && code === 1107) {
    return new ProviderError('auth', status, usage, false, false);
  }
  if (normalized.includes('quota') || normalized.includes('balance')) {
    return new ProviderError('quota', status, usage, false, false);
  }
  if (
    normalized.includes('auth') ||
    normalized.includes('unauthorized') ||
    normalized.includes('forbidden')
  ) {
    return new ProviderError('auth', status, usage, false, false);
  }
  if (normalized.includes('rate') || normalized.includes('limit')) {
    return new ProviderError('rate_limit', status, usage, true, false);
  }
  return new ProviderError('provider', status, usage, false, false);
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
        const businessFailure = classifyBusinessCode(
          config.provider,
          response.data,
          response.status,
          usage,
        );
        if (businessFailure) throw businessFailure;
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
        const form = multipartFile(request);
        form.append('api_key', profile.credentials.apiKey ?? '');
        form.append('output_formats', 'markdown');
        form.append(
          'element_formats',
          JSON.stringify({ image: 'url', formula: 'latex', table: 'markdown', cs: 'image' }),
        );
        body = form;
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
        const preupload = await call({
          method: 'POST',
          url,
          headers: {
            ...headers,
            'Content-Type': 'application/json',
            Authorization: `Bearer ${profile.credentials.apiKey ?? ''}`,
          },
          body: new TextEncoder().encode('{}'),
        });
        const parsedPreupload = PreuploadSchema.safeParse(preupload.data);
        if (
          !parsedPreupload.success ||
          (!parsedPreupload.data.data &&
            (!parsedPreupload.data.uploadUrl || !parsedPreupload.data.statusUrl))
        ) {
          throw new ProviderError('contract', preupload.status, usage, false, true);
        }
        const uploadUrl = parsedPreupload.data.uploadUrl ?? parsedPreupload.data.data?.url;
        const statusUrl =
          parsedPreupload.data.statusUrl ??
          (() => {
            const value = new URL(appendPath(profile.endpoint, '/parse/status'));
            value.searchParams.set('uid', parsedPreupload.data.data!.uid);
            return value.toString();
          })();
        if (!uploadUrl || !statusUrl) {
          throw new ProviderError('contract', preupload.status, usage, false, true);
        }
        await call({
          method: 'PUT',
          url: uploadUrl,
          headers: { ...headers, 'Content-Type': request.mimeType },
          body: request.bytes,
        });
        const deadline = Date.now() + request.timeoutMs;
        while (Date.now() < deadline) {
          const statusResponse = await call({
            method: 'GET',
            url: statusUrl,
            headers: {
              ...headers,
              Authorization: `Bearer ${profile.credentials.apiKey ?? ''}`,
            },
          });
          const native = Doc2xNativeResponseSchema.safeParse(statusResponse.data);
          const legacyRecord = statusResponse.data as {
            status?: unknown;
            error?: unknown;
            markdown?: unknown;
            pages?: unknown;
            result?: { pages?: Array<{ md?: unknown }> };
          };
          if (!native.success && typeof legacyRecord.markdown === 'string') {
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
          }
          if (
            !native.success &&
            (typeof legacyRecord !== 'object' ||
              legacyRecord === null ||
              typeof legacyRecord.status !== 'string')
          ) {
            throw new ProviderError('contract', statusResponse.status, usage, false, true);
          }
          const record = (native.success ? native.data.data : legacyRecord) as {
            status?: unknown;
            error?: unknown;
            result?: { pages?: Array<{ md?: unknown }> };
          };
          if (record.status === 'success') {
            try {
              const pages = (record.result?.pages ?? []).map((page, index) => ({
                pageNumber: index + 1,
                markdown: typeof page.md === 'string' ? page.md : '',
              }));
              if (pages.length === 0 || pages.every((page) => page.markdown.trim() === '')) {
                throw new ProviderError('contract', statusResponse.status, usage, false, true);
              }
              const normalized = {
                status: 'success',
                markdown: pages.map((page) => page.markdown).join('\n\n'),
                pages,
              };
              const result = parseOcrResponse('doc2x', normalized, {
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
        url: config.provider === 'textin' ? textinUrl(profile.endpoint) : url,
        headers: {
          ...headers,
          ...(config.provider === 'textin' ? {} : { 'Content-Type': 'multipart/form-data' }),
        },
        body,
      });
      let normalized = response.data;
      let pageCountHint: number | undefined;
      if (config.provider === 'somark') {
        const native = SomarkNativeResponseSchema.safeParse(response.data);
        if (native.success) {
          normalized = {
            code: native.data.code,
            markdown: native.data.data.result.outputs.markdown,
            pages: [],
          };
          pageCountHint = native.data.data.metadata.page_num;
        }
      } else if (config.provider === 'textin') {
        const native = TextinNativeResponseSchema.safeParse(response.data);
        if (native.success) {
          const pages = [...(native.data.result.pages ?? [])];
          const totalPages = native.data.result.total_page_number ?? 0;
          if (pages.length === 0 && totalPages > 0) {
            pages.push({ pageNumber: 1, markdown: native.data.result.markdown });
          }
          for (let pageNumber = pages.length + 1; pageNumber <= totalPages; pageNumber += 1) {
            pages.push({ pageNumber, markdown: '' });
          }
          normalized = {
            code: native.data.code,
            markdown: native.data.result.markdown,
            pages,
          };
          pageCountHint = native.data.result.total_page_number;
        }
      }
      const result = parseOcrResponse(config.provider, normalized, {
        status: response.status,
        ...(pageCountHint === undefined ? {} : { pageCountHint }),
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
