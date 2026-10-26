import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createKnowledgeError } from '@kb/contracts';
import type { S5RemoteAssetPort } from '../application/s5-ocr-ports';

const MAX_ASSET_BYTES = 20 * 1024 * 1024;
const TOTAL_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 3;

interface LookupAddress {
  address: string;
  family: number;
}

type LookupFn = (hostname: string) => Promise<LookupAddress[]>;
type FetchFn = typeof fetch;

function privateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value))) return true;
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function privateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return (
    normalized === '::1' ||
    normalized === '::' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('::ffff:127.') ||
    normalized.startsWith('::ffff:10.') ||
    normalized.startsWith('::ffff:192.168.')
  );
}

function privateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return privateIpv4(address);
  if (family === 6) return privateIpv6(address);
  return true;
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

  private async assertPublicUrl(value: string): Promise<URL> {
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
    const hostname = url.hostname.toLowerCase();
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname === 'metadata.google.internal'
    ) {
      throw error('KNOWLEDGE_VALIDATION_FAILED', 'asset_host_forbidden');
    }
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await (this.input.lookup ?? ((name) => dnsLookup(name, { all: true })))(hostname);
    if (addresses.length === 0 || addresses.some((entry) => privateAddress(entry.address))) {
      throw error('KNOWLEDGE_VALIDATION_FAILED', 'asset_address_forbidden');
    }
    return url;
  }

  async fetch(value: string) {
    let url = await this.assertPublicUrl(value);
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(), TOTAL_TIMEOUT_MS);
    const fetchImpl = this.input.fetch ?? fetch;
    try {
      let response: Response | undefined;
      for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
        const connect = new AbortController();
        const connectTimer = setTimeout(() => connect.abort(), CONNECT_TIMEOUT_MS);
        try {
          response = await fetchImpl(url, {
            method: 'GET',
            redirect: 'manual',
            signal: AbortSignal.any([deadline.signal, connect.signal]),
          });
        } finally {
          clearTimeout(connectTimer);
        }
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location || redirect === MAX_REDIRECTS) {
            throw error('KNOWLEDGE_DEPENDENCY_UNAVAILABLE', 'asset_redirect_invalid');
          }
          url = await this.assertPublicUrl(new URL(location, url).toString());
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
      clearTimeout(timeout);
    }
  }
}
