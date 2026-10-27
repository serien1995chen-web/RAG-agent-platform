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
        lookup: (_hostname, _options, callback) => {
          callback(null, target.address, target.family);
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

export class KnowledgeUrlImportAdapter implements UrlImportAdapterPort {
  private readonly resolve: typeof validateUrlTarget;
  private readonly requestPage: (
    target: VettedUrlTarget,
    context: TenantContext,
  ) => Promise<PageResponse>;

  constructor(options: UrlImportAdapterOptions = {}) {
    this.resolve = options.resolve ?? validateUrlTarget;
    this.requestPage = options.requestPage ?? defaultRequestPage;
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
        raw = new URL(response.location, target.url).toString();
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
      return {
        finalUrl: raw,
        safeUrl,
        urlHash: createHash('sha256').update(safeUrl).digest('hex'),
        title: titleOf(body),
        contentType: response.contentType || 'text/html',
        bytes: response.bytes,
      };
    }
    return timeoutError(input.context);
  }
}
