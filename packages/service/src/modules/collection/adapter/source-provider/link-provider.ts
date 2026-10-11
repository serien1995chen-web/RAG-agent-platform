/**
 * P4-04 link 来源 Provider 与 SSRF 防护（设计 8.1.1，SOL-ISS-04 冻结）。
 * 只读取用户提交的单个 URL，不做站点递归爬取。
 * 每跳重新校验地址策略；DNS 固定解析结果建连；审计只记 urlHash/host/结果分类。
 * 地址拦截使用字节级 IPv6 解析，内嵌 IPv4（IPv4-compatible/mapped、NAT64、6to4、Teredo）
 * 与直接 IPv4 共用同一拦截判定；大小/字符集/读取超时/取消按 8.1.1 实现。
 */
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { ApiErrorException, createApiError } from '@kb/contracts';
import { Agent } from 'undici';
import type {
  DatasetSourceProvider,
  SourceReadRequest,
  SourceReadResult,
} from '../../../../ports/capabilities';
import type { RequestContext } from '../../../../ports/types';

export interface LinkLimits {
  maxUrlLength: number;
  maxRedirects: number;
  connectTimeoutMs: number;
  readTimeoutMs: number;
  totalTimeoutMs: number;
  maxBytes: number;
  minTextRatio: number;
  retryBackoffMs: readonly number[];
}

export const DEFAULT_LINK_LIMITS: LinkLimits = {
  maxUrlLength: 2048,
  maxRedirects: 5,
  connectTimeoutMs: 5000,
  readTimeoutMs: 15000,
  totalTimeoutMs: 30000,
  maxBytes: 10 * 1024 * 1024,
  minTextRatio: 0.05,
  retryBackoffMs: [1000, 3000],
};

export interface LinkFetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer?(): Promise<ArrayBuffer>;
  body?: ReadableStream<Uint8Array> | null;
}

export type LinkFetcher = (
  url: string,
  init: {
    signal: AbortSignal;
    redirect: 'manual';
    dispatcher?: unknown;
    headers?: Record<string, string>;
  },
) => Promise<LinkFetchResponse>;

export interface LinkSourceProviderDeps {
  fetcher?: LinkFetcher;
  resolveHost?: (hostname: string) => Promise<string[]>;
  audit?: SourceAuditSink;
  limits?: Partial<LinkLimits>;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
  /** 调用方取消信号；透传/合并到 fetch，abort 后不再读正文或写正文审计。 */
  signal?: AbortSignal;
}

function normalizeHost(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const ALLOWED_PORTS = new Set([80, 443]);
const CLOUD_METADATA_HOSTS = ['metadata.', 'metadata.google.internal', 'kubernetes.'];
const BLOCKED_LITERAL_HOSTS = new Set(['169.254.169.254', '100.100.100.200', 'fd00:ec2::254']);
const HTML_CONTENT_TYPES = new Set(['text/html', 'application/xhtml+xml']);
const PLAIN_CONTENT_TYPES = new Set(['text/plain']);

/** 单一真值来源：IPv4 拦截判定；直接 IPv4 与所有内嵌 IPv4 共用。 */
function isBlockedIpv4Int(value: number): boolean {
  const ranges: Array<[number, number]> = [
    [0x00000000, 0x00ffffff],
    [0x0a000000, 0x0affffff],
    [0x64400000, 0x647fffff],
    [0x7f000000, 0x7fffffff],
    [0xa9fe0000, 0xa9ffffff],
    [0xac100000, 0xac1fffff],
    [0xc0000000, 0xc00000ff],
    [0xc0000200, 0xc00002ff],
    [0xc0a80000, 0xc0a8ffff],
    [0xc6120000, 0xc613ffff],
    [0xc6336400, 0xc63364ff],
    [0xcb007100, 0xcb0071ff],
    [0xe0000000, 0xefffffff],
    [0xf0000000, 0xffffffff],
  ];
  return ranges.some(([start, end]) => value >= start && value <= end);
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const byte = Number(part);
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) return null;
    value = value * 256 + byte;
  }
  return value >>> 0;
}

function decodeIpv4Literal(host: string): string | null {
  if (/^\d+$/.test(host)) {
    const value = Number(host);
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) return null;
    return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
  }
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    let parsed: number;
    if (/^0x[0-9a-f]+$/i.test(part)) parsed = Number.parseInt(part, 16);
    else if (/^0[0-7]+$/.test(part)) parsed = Number.parseInt(part, 8);
    else if (/^\d+$/.test(part)) parsed = Number.parseInt(part, 10);
    else return null;
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 255) return null;
    bytes.push(parsed);
  }
  while (bytes.length < 4) bytes.push(0);
  return bytes.join('.');
}

/** 把 IPv6 文本解析为 8 个 16 位组；支持 "::" 压缩与尾部内嵌 IPv4；失败返回 null。 */
function parseIpv6(raw: string): number[] | null {
  let s = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  s = s.split('%')[0] ?? s;
  const v4groups: number[] = [];
  const lastColon = s.lastIndexOf(':');
  const tailToken = lastColon >= 0 ? s.slice(lastColon + 1) : s;
  if (tailToken.includes('.')) {
    const v = ipv4ToInt(tailToken);
    if (v === null) return null;
    v4groups.push((v >>> 16) & 0xffff, v & 0xffff);
    s = s.slice(0, lastColon + 1);
  }
  const dbl = s.split('::');
  if (dbl.length > 2) return null;
  const parseGroups = (str: string): number[] | null => {
    if (str === '') return [];
    const out: number[] = [];
    for (const h of str.split(':')) {
      if (h === '') continue;
      if (!/^[0-9a-f]{1,4}$/i.test(h)) return null;
      out.push(Number.parseInt(h, 16));
    }
    return out;
  };
  const left = parseGroups(dbl[0] ?? '');
  if (!left) return null;
  const right = dbl.length === 2 ? parseGroups(dbl[1] ?? '') : [];
  if (!right) return null;
  const target = 8 - v4groups.length;
  let groups: number[];
  if (dbl.length === 2) {
    const fill = target - left.length - right.length;
    if (fill < 0) return null;
    groups = [...left, ...new Array<number>(fill).fill(0), ...right];
  } else {
    groups = [...left];
  }
  groups = [...groups, ...v4groups];
  return groups.length === 8 ? groups : null;
}

/** 提取可在 IPv6 中内嵌的 IPv4 值（32 位）。 */
function embeddedIpv4Candidates(groups: number[]): number[] {
  const g = (i: number): number => groups[i] ?? 0;
  const v4 = (hi: number, lo: number): number => (((hi << 16) | lo) & 0xffffffff) >>> 0;
  const first5Zero = [0, 1, 2, 3, 4].every((i) => g(i) === 0);
  const first6Zero = first5Zero && g(5) === 0;
  const out: number[] = [];
  if (first5Zero && g(5) === 0xffff) out.push(v4(g(6), g(7))); // IPv4-mapped ::ffff:0:0/96
  if (first6Zero) {
    const cand = v4(g(6), g(7));
    if (cand > 1) out.push(cand); // IPv4-compatible ::a.b.c.d（排除 :: 与 ::1）
  }
  if (g(0) === 0x0064 && g(1) === 0xff9b && [2, 3, 4, 5].every((i) => g(i) === 0)) {
    out.push(v4(g(6), g(7))); // NAT64 64:ff9b::/96
  }
  if (g(0) === 0x2002) out.push(v4(g(1), g(2))); // 6to4 2002::/16
  if (g(0) === 0x2001 && g(1) === 0x0000) {
    out.push(v4(g(2), g(3))); // Teredo 服务器 IPv4
    out.push((~v4(g(6), g(7))) >>> 0); // Teredo 混淆后的客户端 IPv4
  }
  return out;
}

/** 判断地址是否命中拦截集合（loopback/private/linkLocal/uniqueLocal/reserved/multicast/broadcast/unspecified/CGNAT 及内嵌 IPv4）。 */
export function isBlockedAddress(address: string): boolean {
  const normalized = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  if (BLOCKED_LITERAL_HOSTS.has(normalized)) return true;
  if (isIP(normalized) === 4) {
    const value = ipv4ToInt(normalized);
    return value === null ? true : isBlockedIpv4Int(value);
  }
  if (isIP(normalized) === 6) {
    const groups = parseIpv6(normalized);
    if (!groups) return true;
    if (groups.every((x) => x === 0)) return true; // ::
    if (groups.slice(0, 7).every((x) => x === 0) && groups[7] === 1) return true; // ::1
    const g0 = groups[0] ?? 0;
    if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10
    if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7
    if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8
    if (g0 === 0x2001 && (groups[1] ?? 0) === 0x0db8) return true; // 2001:db8::/32
    if (embeddedIpv4Candidates(groups).some((cand) => isBlockedIpv4Int(cand))) return true;
    return false;
  }
  return true;
}

export function isCloudMetadataHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return CLOUD_METADATA_HOSTS.some(
    (prefix) => lower === prefix.replace(/\.$/, '') || lower.startsWith(prefix),
  );
}

// ---------------------------------------------------------------------------
// 字符集探测/解码（Node 内建 TextDecoder，不新增依赖）
// ---------------------------------------------------------------------------

type BodyEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030';

function startsWithBytes(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, i) => bytes[i] === byte);
}

function detectBodyEncoding(bytes: Uint8Array, headerCharset: string | undefined): BodyEncoding {
  const declared = (headerCharset ?? '').toLowerCase();
  if (declared === 'utf-8' || declared === 'utf8') return 'utf-8';
  if (declared === 'gbk' || declared === 'gb2312' || declared === 'gb18030') return 'gb18030';
  if (declared === 'utf-16' || declared === 'utf-16le') return 'utf-16le';
  if (declared === 'utf-16be') return 'utf-16be';

  if (startsWithBytes(bytes, [0xef, 0xbb, 0xbf])) return 'utf-8';
  if (startsWithBytes(bytes, [0xff, 0xfe])) return 'utf-16le';
  if (startsWithBytes(bytes, [0xfe, 0xff])) return 'utf-16be';

  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, 4096))
    .toLowerCase();
  const meta = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_-]+)/i.exec(head)?.[1];
  if (meta) {
    if (meta === 'gbk' || meta === 'gb2312' || meta === 'gb18030') return 'gb18030';
    if (meta === 'utf-16le') return 'utf-16le';
    if (meta === 'utf-16be') return 'utf-16be';
    return 'utf-8';
  }

  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 8192));
  let replacement = 0;
  for (const char of decoded) if (char === '\ufffd') replacement += 1;
  if (decoded.length > 0 && replacement / decoded.length > 0.01) return 'gb18030';
  return 'utf-8';
}

/** 解码正文：非法字节以 U+FFFD 替换（告警由调用方记录），并去 BOM。 */
function decodeBody(bytes: Uint8Array, encoding: BodyEncoding): string {
  let text = new TextDecoder(encoding, { fatal: false }).decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

function charsetOf(contentType: string): string | undefined {
  const match = /charset\s*=\s*["']?\s*([a-z0-9_-]+)/i.exec(contentType);
  return match?.[1];
}

class SizeLimitExceeded extends Error {
  constructor(readonly actualBytes: number) {
    super('size_limit_exceeded');
    this.name = 'SizeLimitExceeded';
  }
}

async function readStreamLimited(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new SizeLimitExceeded(total);
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

interface ParsedTarget {
  url: URL;
  host: string;
  addresses: string[];
}

function defaultResolveHost(hostname: string): Promise<string[]> {
  return import('node:dns/promises')
    .then((dns) => dns.lookup(hostname, { all: true }))
    .then((records) => records.map((record) => record.address));
}

export function defaultLinkFetcher(
  url: string,
  init: {
    signal: AbortSignal;
    redirect: 'manual';
    dispatcher?: unknown;
    headers?: Record<string, string>;
  },
): Promise<LinkFetchResponse> {
  return fetch(url, init as RequestInit) as unknown as Promise<LinkFetchResponse>;
}

export function createLinkSourceProvider(deps: LinkSourceProviderDeps = {}): DatasetSourceProvider {
  const limits: LinkLimits = { ...DEFAULT_LINK_LIMITS, ...deps.limits };
  const fetchImpl: LinkFetcher = deps.fetcher ?? defaultLinkFetcher;
  const resolveHost = deps.resolveHost ?? defaultResolveHost;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.clock ?? (() => Date.now());

  const audit = (entry: Parameters<SourceAuditSink>[0]): void => {
    deps.audit?.(entry);
  };

  const validateAndResolve = async (rawUrl: string, requestId: string): Promise<ParsedTarget> => {
    if (rawUrl.length > limits.maxUrlLength) {
      throw sourceError(501031, requestId, { urlHash: hashUrl(rawUrl), protocol: 'length' });
    }
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw sourceError(501031, requestId, { urlHash: hashUrl(rawUrl), protocol: 'invalid' });
    }
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
      throw sourceError(501031, requestId, { urlHash: hashUrl(rawUrl), protocol: url.protocol });
    }
    if (url.username.length > 0 || url.password.length > 0) {
      throw sourceError(501031, requestId, { urlHash: hashUrl(rawUrl), protocol: 'userinfo' });
    }
    const port = url.port.length > 0 ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    if (!ALLOWED_PORTS.has(port)) {
      throw sourceError(501031, requestId, {
        urlHash: hashUrl(rawUrl),
        protocol: 'port:' + String(port),
      });
    }
    const host = normalizeHost(url.hostname);
    if (isCloudMetadataHost(host)) {
      throw sourceError(501032, requestId, {
        urlHash: hashUrl(rawUrl),
        reason: 'cloud_metadata_host',
      });
    }
    const literal = decodeIpv4Literal(host);
    if (literal && isBlockedAddress(literal)) {
      throw sourceError(501032, requestId, { urlHash: hashUrl(rawUrl), reason: 'literal_address' });
    }
    if (isIP(host) !== 0 && isBlockedAddress(host)) {
      throw sourceError(501032, requestId, { urlHash: hashUrl(rawUrl), reason: 'literal_address' });
    }
    let addresses: string[];
    if (isIP(host) !== 0) addresses = [host];
    else addresses = await resolveHost(host);
    if (addresses.length === 0) {
      throw sourceError(501032, requestId, { urlHash: hashUrl(rawUrl), reason: 'dns_empty' });
    }
    for (const address of addresses) {
      if (isBlockedAddress(address)) {
        throw sourceError(501032, requestId, { urlHash: hashUrl(rawUrl), reason: 'dns_blocked' });
      }
    }
    return { url, host, addresses };
  };

  const dispatch = async (
    target: ParsedTarget,
    callerSignal: AbortSignal | undefined,
  ): Promise<{
    status: number;
    headers: LinkFetchResponse['headers'];
    bytes: Uint8Array;
    contentType: string;
  }> => {
    const controller = new AbortController();
    const totalTimer = setTimeout(() => controller.abort(), limits.totalTimeoutMs);
    const readTimer = setTimeout(() => controller.abort(), limits.readTimeoutMs);
    const onCallerAbort = (): void => controller.abort();
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort();
      else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
    const dispatcher = createPinnedDispatcher(
      target.addresses[0] ?? '0.0.0.0',
      limits.connectTimeoutMs,
    );
    try {
      const response = await fetchImpl(target.url.toString(), {
        signal: controller.signal,
        redirect: 'manual',
        dispatcher,
        headers: { accept: 'text/html,application/xhtml+xml,text/plain' },
      });
      const contentType = (response.headers.get('content-type') ?? '').trim().toLowerCase();
      const declared = response.headers.get('content-length');
      if (declared !== null) {
        const size = Number(declared);
        if (Number.isFinite(size) && size > limits.maxBytes) {
          throw new SizeLimitExceeded(size);
        }
      }
      let bytes: Uint8Array;
      if (response.body) {
        bytes = await readStreamLimited(response.body, limits.maxBytes);
      } else if (response.arrayBuffer) {
        const buffer = await response.arrayBuffer();
        bytes = new Uint8Array(buffer);
      } else {
        bytes = new TextEncoder().encode(await response.text());
      }
      if (bytes.byteLength > limits.maxBytes) {
        throw new SizeLimitExceeded(bytes.byteLength);
      }
      return { status: response.status, headers: response.headers, bytes, contentType };
    } finally {
      clearTimeout(totalTimer);
      clearTimeout(readTimer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
      void (dispatcher as { close(): Promise<void> }).close();
    }
  };

  const read = async (
    request: SourceReadRequest,
    context: RequestContext,
  ): Promise<SourceReadResult> => {
    const requestId = context.requestId;
    let currentUrl = request.sourceRef;
    let redirects = 0;
    const started = now();
    let attempt = 0;
    for (;;) {
      let target: ParsedTarget;
      try {
        target = await validateAndResolve(currentUrl, requestId);
      } catch (error) {
        if (error instanceof Error && error.name === 'ApiErrorException') {
          audit({
            event: 'source.blocked',
            urlHash: hashUrl(currentUrl),
            host: safeHost(currentUrl),
            outcome: 'blocked',
          });
        }
        throw error;
      }
      let response: {
        status: number;
        headers: LinkFetchResponse['headers'];
        bytes: Uint8Array;
        contentType: string;
      };
      try {
        response = await dispatch(target, deps.signal);
      } catch (error) {
        if (error instanceof SizeLimitExceeded) {
          audit({
            event: 'source.failed',
            urlHash: hashUrl(currentUrl),
            host: target.host,
            outcome: 'size',
          });
          throw sourceError(501065, requestId, {
            limitBytes: limits.maxBytes,
            actualBytes: error.actualBytes,
            urlHash: hashUrl(currentUrl),
          });
        }
        if (attempt < limits.retryBackoffMs.length && isTimeout(error)) {
          await sleep(limits.retryBackoffMs[attempt] ?? 0);
          attempt += 1;
          continue;
        }
        audit({
          event: 'source.failed',
          urlHash: hashUrl(currentUrl),
          host: target.host,
          outcome: 'timeout',
        });
        throw sourceError(501034, requestId, {
          urlHash: hashUrl(currentUrl),
          timeoutMs: limits.totalTimeoutMs,
        });
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw sourceError(501033, requestId, { urlHash: hashUrl(currentUrl), hops: redirects });
        }
        redirects += 1;
        if (redirects > limits.maxRedirects) {
          throw sourceError(501033, requestId, { urlHash: hashUrl(currentUrl), hops: redirects });
        }
        const next = new URL(location, target.url);
        if (target.url.protocol === 'https:' && next.protocol === 'http:') {
          throw sourceError(501031, requestId, {
            urlHash: hashUrl(next.toString()),
            protocol: 'https_downgrade',
          });
        }
        currentUrl = next.toString();
        continue;
      }

      if (response.status >= 500) {
        if (attempt < limits.retryBackoffMs.length && now() - started < limits.totalTimeoutMs) {
          await sleep(limits.retryBackoffMs[attempt] ?? 0);
          attempt += 1;
          continue;
        }
        audit({
          event: 'source.failed',
          urlHash: hashUrl(currentUrl),
          host: target.host,
          outcome: 'http_' + String(response.status),
        });
        throw sourceError(501034, requestId, {
          urlHash: hashUrl(currentUrl),
          timeoutMs: limits.totalTimeoutMs,
        });
      }
      if (response.status >= 400) {
        audit({
          event: 'source.failed',
          urlHash: hashUrl(currentUrl),
          host: target.host,
          outcome: 'http_' + String(response.status),
        });
        throw sourceError(501039, requestId, { provider: 'link', status: response.status });
      }

      const baseType = response.contentType.split(';')[0]?.trim().toLowerCase() ?? '';
      const allowed = HTML_CONTENT_TYPES.has(baseType) || PLAIN_CONTENT_TYPES.has(baseType);
      if (!allowed) {
        audit({
          event: 'source.failed',
          urlHash: hashUrl(currentUrl),
          host: target.host,
          outcome: 'content_type',
        });
        throw sourceError(501035, requestId, {
          contentType: baseType,
          urlHash: hashUrl(currentUrl),
        });
      }

      const isHtml = HTML_CONTENT_TYPES.has(baseType);
      const body = decodeBody(response.bytes, detectBodyEncoding(response.bytes, charsetOf(response.contentType)));
      const rawText = isHtml ? htmlToMarkdown(body, target.url) : body;
      const plain = isHtml ? stripTags(body) : body;
      const ratio =
        plain.length === 0
          ? 0
          : Math.min(1, plain.replace(/\s/g, '').length / Math.max(1, response.bytes.byteLength));
      if (plain.trim().length === 0 || ratio < limits.minTextRatio) {
        audit({
          event: 'source.failed',
          urlHash: hashUrl(currentUrl),
          host: target.host,
          outcome: 'empty_content',
        });
        throw sourceError(501036, requestId, { urlHash: hashUrl(currentUrl), textRatio: ratio });
      }
      audit({ event: 'source.read', urlHash: hashUrl(currentUrl), host: target.host, outcome: 'ok' });
      return { rawText, contentHash: hashSourceText(rawText) };
    }
  };

  return { read, preview: read };
}

function createPinnedDispatcher(address: string, connectTimeoutMs: number): unknown {
  return new Agent({
    connect: {
      timeout: connectTimeoutMs,
      lookup: (_hostname, options, callback) => {
        const cb = callback as unknown as (
          err: NodeJS.ErrnoException | null,
          address: string,
          family: number,
        ) => void;
        cb(null, address, isIP(address));
      },
    },
  });
}

function isTimeout(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as Record<string, unknown>;
  return (
    record.name === 'AbortError' ||
    record.name === 'TimeoutError' ||
    record.code === 'UND_ERR_CONNECT_TIMEOUT'
  );
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function stripTags(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ');
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, '\u0027')
    .replace(/&apos;/gi, '\u0027')
    .replace(/&amp;/gi, '&');
}

function absolutize(url: string, base: URL): string {
  try {
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}

/** 自研 HTML→Markdown：移除 script/style/nav/注释，保留标题/列表/表格/代码块，链接与图片绝对化。 */
export function htmlToMarkdown(input: string, base?: URL): string {
  let html = input
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|nav|noscript|template)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(script|style|nav|noscript|template)[^>]*\/?>/gi, '');
  html = html
    .replace(/<a\b[^>]*href\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const target = base ? absolutize(href, base) : href;
      return '[' + stripTags(label).trim() + '](' + target + ')';
    })
    .replace(/<img\b[^>]*alt\s*=\s*"([^"]*)"[^>]*src\s*=\s*"([^"]+)"[^>]*\/?>/gi, (_m, alt: string, src: string) => {
      const target = base ? absolutize(src, base) : src;
      return '![' + alt + '](' + target + ')';
    });
  for (let level = 6; level >= 1; level -= 1) {
    const pattern = new RegExp('<h' + String(level) + '[^>]*>([\\s\\S]*?)<\\/h' + String(level) + '>', 'gi');
    html = html.replace(
      pattern,
      (_m, content: string) => '\n' + '#'.repeat(level) + ' ' + stripTags(content).trim() + '\n',
    );
  }
  html = html
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, content: string) => '\n- ' + stripTags(content).trim())
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, content: string) => '\n```\n' + decodeEntities(stripTags(content)).trim() + '\n```\n')
    .replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_m, row: string) => {
      const cells = [...row.matchAll(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)].map((cell) =>
        stripTags(cell[1] ?? '')
          .trim()
          .replace(/\|/g, '\\|'),
      );
      return '\n| ' + cells.join(' | ') + ' |';
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|ul|ol|table)>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(html)
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// 来源 Provider 公共工具（原 shared.ts 合并至此；审计只记 urlHash/host/结果分类）
// ---------------------------------------------------------------------------

export function hashSourceText(text: string): string {
  return 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex');
}

export function hashUrl(url: string): string {
  return 'sha256:' + createHash('sha256').update(url, 'utf8').digest('hex');
}

export function sourceError(
  code: number,
  requestId: string,
  params: Record<string, unknown> = {},
): ApiErrorException {
  return new ApiErrorException(createApiError({ code, requestId, params }));
}

export interface SourceReadAudit {
  event: 'source.read' | 'source.blocked' | 'source.retry' | 'source.failed';
  urlHash?: string;
  host?: string;
  outcome: string;
}

export type SourceAuditSink = (entry: SourceReadAudit) => void;
