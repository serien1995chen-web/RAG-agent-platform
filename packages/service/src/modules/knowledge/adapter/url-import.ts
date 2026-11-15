import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createKnowledgeError } from '@kb/contracts';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type { UrlImportAdapterPort, UrlSnapshot } from '../application/ingestion.ports';
import {
  safeUrlForStorage,
  validateUrlSyntax,
  validateUrlTarget,
  type VettedUrlTarget,
} from './ssrf';

const MAX_REDIRECTS = 5;
const CONNECT_TIMEOUT_MS = 5000;
const TOTAL_TIMEOUT_MS = 30_000;
const MAX_BYTES = 50 * 1024 * 1024;

interface PageResponse {
  status: number;
  location: string | null;
  contentType: string;
  bytes: Uint8Array;
}

export interface UrlImportAdapterOptions {
  resolve?: typeof validateUrlTarget;
  requestPage?: (target: VettedUrlTarget, context: TenantContext) => Promise<PageResponse>;
  extractHtml?: (input: {
    html: string;
    selector: string;
    baseUrl: string;
    requestId: string;
    traceId: string;
  }) => Promise<{
    title: string;
    markdown: string;
    usedSelector: string;
  }>;
}

function timeoutError(context: TenantContext): never {
  throw createKnowledgeError({
    code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT',
    requestId: context.requestId,
    traceId: context.traceId,
    details: { dependency: 'url', timeoutMs: TOTAL_TIMEOUT_MS },
  });
}

async function defaultRequestPage(
  target: VettedUrlTarget,
  context: TenantContext,
): Promise<PageResponse> {
  return new Promise<PageResponse>((resolve, reject) => {
    const request = target.url.protocol === 'https:' ? httpsRequest : httpRequest;
    let settled = false;
    const finish = (work: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      work();
    };
    const totalTimer = setTimeout(() => {
      requestInstance.destroy();
      finish(() => {
        try {
          timeoutError(context);
        } catch (error) {
          reject(error);
        }
      });
    }, TOTAL_TIMEOUT_MS);
    const requestInstance = request(
      target.url,
      {
        method: 'GET',
        headers: {
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
          'user-agent': 'RAG-agent-platform-url-import/1.0',
        },
        lookup: (_hostname, options, callback) => {
          const lookupCallback = callback as unknown as (...args: unknown[]) => void;
          if ((options as { all?: boolean }).all) {
            lookupCallback(null, [{ address: target.address, family: target.family }]);
            return;
          }
          lookupCallback(null, target.address, target.family);
        },
        servername: target.url.hostname,
        timeout: CONNECT_TIMEOUT_MS,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location =
          typeof response.headers.location === 'string' ? response.headers.location : null;
        if (status >= 300 && status < 400) {
          response.resume();
          finish(() =>
            resolve({
              status,
              location,
              contentType: String(response.headers['content-type'] ?? ''),
              bytes: new Uint8Array(),
            }),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > MAX_BYTES) {
            requestInstance.destroy();
            finish(() => {
              reject(
                createKnowledgeError({
                  code: 'KNOWLEDGE_PAYLOAD_TOO_LARGE',
                  requestId: context.requestId,
                  traceId: context.traceId,
                  details: { dependency: 'url', limitBytes: MAX_BYTES },
                }),
              );
            });
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          finish(() =>
            resolve({
              status,
              location,
              contentType: String(response.headers['content-type'] ?? ''),
              bytes: Buffer.concat(chunks),
            }),
          );
        });
        response.on('error', (error) => finish(() => reject(error)));
      },
    );
    requestInstance.on('timeout', () => {
      requestInstance.destroy(
        createKnowledgeError({
          code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT',
          requestId: context.requestId,
          traceId: context.traceId,
          details: { dependency: 'url', timeoutMs: CONNECT_TIMEOUT_MS },
        }),
      );
    });
    requestInstance.on('error', (error) =>
      finish(() => {
        if (error.name === 'KnowledgeApiError') {
          reject(error);
          return;
        }
        reject(
          createKnowledgeError({
            code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
            requestId: context.requestId,
            traceId: context.traceId,
            details: { dependency: 'url' },
          }),
        );
      }),
    );
    requestInstance.end();
  });
}

function titleOf(body: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body);
  return match?.[1]?.replace(/\s+/g, ' ').trim().slice(0, 240) || 'Imported page';
}

async function fallbackExtractHtml(input: {
  html: string;
  selector: string;
  baseUrl: string;
  requestId: string;
  traceId: string;
}) {
  const usedSelector = input.selector.trim() || 'body';
  const title = (
    /<title[^>]*>([\s\S]*?)<\/title>/i.exec(input.html)?.[1]?.replace(/\s+/g, ' ').trim() ||
    /<h1[^>]*>([\s\S]*?)<\/h1>/i
      .exec(input.html)?.[1]
      ?.replace(/<[^>]+>/g, '')
      .trim() ||
    input.baseUrl
  ).slice(0, 240);
  const cleaned = input.html
    .replace(/<i\b[^>]*>[\s\S]*?<\/i>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<a\b[^>]*>\s*<\/a>/gi, '');
  const text = cleaned
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_UNSUPPORTED_CONTENT',
      requestId: input.requestId,
      traceId: input.traceId,
      details: { source: 'url_html', reason: 'content_empty' },
    });
  }
  return { title: title || input.baseUrl, markdown: text, usedSelector };
}

export class KnowledgeUrlImportAdapter implements UrlImportAdapterPort {
  private readonly resolve: typeof validateUrlTarget;
  private readonly requestPage: (
    target: VettedUrlTarget,
    context: TenantContext,
  ) => Promise<PageResponse>;
  private readonly extractHtml: NonNullable<UrlImportAdapterOptions['extractHtml']>;

  constructor(options: UrlImportAdapterOptions = {}) {
    this.resolve = options.resolve ?? validateUrlTarget;
    this.requestPage = options.requestPage ?? defaultRequestPage;
    this.extractHtml = options.extractHtml ?? fallbackExtractHtml;
  }

  async fetch(input: {
    url: string;
    selector: string;
    context: TenantContext;
  }): Promise<UrlSnapshot> {
    let raw = validateUrlSyntax(input.url, input.context).toString();
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      const target = await this.resolve(raw, input.context);
      const response = await this.requestPage(target, input.context);
      if (response.status >= 300 && response.status < 400) {
        if (redirect === MAX_REDIRECTS) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_UNSUPPORTED_CONTENT',
            requestId: input.context.requestId,
            traceId: input.context.traceId,
            details: { reason: 'redirect_limit', field: 'url' },
          });
        }
        if (!response.location) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_PROVIDER_CONTRACT_INVALID',
            requestId: input.context.requestId,
            traceId: input.context.traceId,
            details: { provider: 'url', reason: 'redirect_location_missing' },
          });
        }
        let next: URL;
        try {
          next = new URL(response.location, target.url);
        } catch {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_PROVIDER_CONTRACT_INVALID',
            requestId: input.context.requestId,
            traceId: input.context.traceId,
            details: { provider: 'url', reason: 'redirect_location_invalid' },
          });
        }
        if (target.url.protocol === 'https:' && next.protocol === 'http:') {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_UNSUPPORTED_CONTENT',
            requestId: input.context.requestId,
            traceId: input.context.traceId,
            details: { provider: 'url', reason: 'protocol_downgrade', field: 'url' },
          });
        }
        raw = next.toString();
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
          requestId: input.context.requestId,
          traceId: input.context.traceId,
          details: { provider: 'url', providerStatus: response.status },
        });
      }
      if (response.status < 200 || response.status >= 300) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
          requestId: input.context.requestId,
          traceId: input.context.traceId,
          details: { provider: 'url', providerStatus: response.status },
        });
      }
      const safeUrl = safeUrlForStorage(raw);
      const body = new TextDecoder().decode(response.bytes);
      const mimeType = response.contentType.split(';')[0]?.trim().toLowerCase() || 'text/html';
      if (!['text/html', 'application/xhtml+xml', 'text/plain'].includes(mimeType)) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_UNSUPPORTED_CONTENT',
          requestId: input.context.requestId,
          traceId: input.context.traceId,
          details: { provider: 'url', reason: 'unsupported_mime', mimeType },
        });
      }
      const extracted =
        mimeType === 'text/plain'
          ? {
              title: safeUrl,
              markdown: body.trim(),
              usedSelector: 'body',
            }
          : await this.extractHtml({
              html: body,
              selector: input.selector,
              baseUrl: safeUrl,
              requestId: input.context.requestId,
              traceId: input.context.traceId,
            });
      if (!extracted.markdown.trim()) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_UNSUPPORTED_CONTENT',
          requestId: input.context.requestId,
          traceId: input.context.traceId,
          details: { provider: 'url', reason: 'content_empty' },
        });
      }
      return {
        finalUrl: raw,
        safeUrl,
        urlHash: createHash('sha256').update(safeUrl).digest('hex'),
        title: extracted.title || titleOf(body),
        contentType: mimeType,
        bytes: response.bytes,
        selector: extracted.usedSelector,
        markdown: extracted.markdown,
        contentHash: `sha256:${createHash('sha256').update(extracted.markdown).digest('hex')}`,
      };
    }
    return timeoutError(input.context);
  }
}
