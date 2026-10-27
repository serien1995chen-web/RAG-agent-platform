import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createKnowledgeError } from '@kb/contracts';
import { Agent, fetch as undiciFetch } from 'undici';
import type { S5RemoteAssetPort } from '../application/s5-ocr-ports';
import { isForbiddenAddress } from './ssrf';

const MAX_ASSET_BYTES = 20 * 1024 * 1024;
const TOTAL_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 3;

interface LookupAddress {
  address: string;
  family: number;
}

type LookupFn = (hostname: string) => Promise<LookupAddress[]>;
type FetchFn = (input: URL, init: Record<string, unknown>) => Promise<Response>;

interface VettedAssetTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

function error(
  code:
    | 'KNOWLEDGE_VALIDATION_FAILED'
    | 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE'
    | 'KNOWLEDGE_PAYLOAD_TOO_LARGE',
  reason: string,
) {
  return createKnowledgeError({
    code,
    requestId: 'ocr-asset',
    traceId: 'ocr-asset',
    details: { reason },
  });
}

export class S5RemoteAssetAdapter implements S5RemoteAssetPort {
  constructor(
    private readonly input: {
      fetch?: FetchFn;
      lookup?: LookupFn;
      maxBytes?: number;
    } = {},
  ) {}

  private async assertPublicUrl(value: string): Promise<VettedAssetTarget> {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw error('KNOWLEDGE_VALIDATION_FAILED', 'asset_url_invalid');
    }
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      throw error('KNOWLEDGE_VALIDATION_FAILED', 'asset_url_scheme_invalid');
    }
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname === 'metadata.google.internal'
    ) {
      throw error('KNOWLEDGE_VALIDATION_FAILED', 'asset_host_forbidden');
    }
    const literalFamily = isIP(hostname);
    const addresses = literalFamily
      ? [{ address: hostname, family: literalFamily }]
      : await (this.input.lookup ?? ((name) => dnsLookup(name, { all: true })))(hostname);
    if (addresses.length === 0 || addresses.some((entry) => isForbiddenAddress(entry.address))) {
      throw error('KNOWLEDGE_VALIDATION_FAILED', 'asset_address_forbidden');
    }
    const selected = addresses[0];
    if (!selected || (selected.family !== 4 && selected.family !== 6)) {
      throw error('KNOWLEDGE_VALIDATION_FAILED', 'asset_address_forbidden');
    }
    return { url, address: selected.address, family: selected.family };
  }

  async fetch(value: string) {
    let target = await this.assertPublicUrl(value);
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(), TOTAL_TIMEOUT_MS);
    const fetchImpl: FetchFn =
      this.input.fetch ??
      ((input, init) =>
        undiciFetch(
          input,
          init as Parameters<typeof undiciFetch>[1],
        ) as unknown as Promise<Response>);
    const dispatchers: Agent[] = [];
    try {
      let response: Response | undefined;
      for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
        const connect = new AbortController();
        const connectTimer = setTimeout(() => connect.abort(), CONNECT_TIMEOUT_MS);
        const dispatcher = new Agent({
          connect: {
            lookup: (_hostname, options, callback) => {
              if (options.all) {
                callback(null, [{ address: target.address, family: target.family }]);
                return;
              }
              callback(null, target.address, target.family);
            },
          },
        });
        dispatchers.push(dispatcher);
        try {
          response = await fetchImpl(target.url, {
            method: 'GET',
            redirect: 'manual',
            signal: AbortSignal.any([deadline.signal, connect.signal]),
            dispatcher,
          });
        } finally {
          clearTimeout(connectTimer);
        }
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location || redirect === MAX_REDIRECTS) {
            throw error('KNOWLEDGE_DEPENDENCY_UNAVAILABLE', 'asset_redirect_invalid');
          }
          target = await this.assertPublicUrl(new URL(location, target.url).toString());
          continue;
        }
        break;
      }
      if (!response || response.status < 200 || response.status >= 300) {
        throw error('KNOWLEDGE_DEPENDENCY_UNAVAILABLE', 'asset_fetch_failed');
      }
      const contentType = (response.headers.get('content-type') ?? '')
        .split(';')[0]
        ?.trim()
        .toLowerCase();
      if (!contentType?.startsWith('image/')) {
        throw error('KNOWLEDGE_VALIDATION_FAILED', 'asset_not_image');
      }
      const maxBytes = this.input.maxBytes ?? MAX_ASSET_BYTES;
      const declaredLength = Number(response.headers.get('content-length') ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw error('KNOWLEDGE_PAYLOAD_TOO_LARGE', 'asset_too_large');
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxBytes) {
        throw error('KNOWLEDGE_PAYLOAD_TOO_LARGE', 'asset_too_large');
      }
      return {
        bytes,
        mimeType: contentType,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    } catch (caught) {
      if (caught instanceof Error && caught.name === 'KnowledgeApiError') throw caught;
      if (deadline.signal.aborted) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT',
          requestId: 'ocr-asset',
          traceId: 'ocr-asset',
          details: { reason: 'asset_fetch_timeout' },
        });
      }
      throw error('KNOWLEDGE_DEPENDENCY_UNAVAILABLE', 'asset_fetch_failed');
    } finally {
      await Promise.all(dispatchers.map((dispatcher) => dispatcher.close()));
      clearTimeout(timeout);
    }
  }
}
