/**
 * P4-04 link 来源 Provider 与 SSRF 防护（设计 8.1.1，SOL-ISS-04 冻结）。
 * 只读取用户提交的单个 URL，不做站点递归爬取。
 * 每跳重新校验地址策略；DNS 固定解析结果建连；审计只记 urlHash/host/结果分类。
 */
import { isIP } from "node:net";
import { Agent } from "undici";
import type {
  DatasetSourceProvider,
  SourceReadRequest,
  SourceReadResult,
} from "../../../../ports/capabilities";
import type { RequestContext } from "../../../../ports/types";
import { hashSourceText, hashUrl, sourceError, type SourceAuditSink } from "./shared";

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
}

export type LinkFetcher = (
  url: string,
  init: { signal: AbortSignal; redirect: "manual"; dispatcher?: unknown; headers?: Record<string, string> },
) => Promise<LinkFetchResponse>;

export interface LinkSourceProviderDeps {
  fetcher?: LinkFetcher;
  resolveHost?: (hostname: string) => Promise<string[]>;
  audit?: SourceAuditSink;
  limits?: Partial<LinkLimits>;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
}

function normalizeHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const ALLOWED_PORTS = new Set([80, 443]);
const CLOUD_METADATA_HOSTS = ["metadata.", "metadata.google.internal", "kubernetes."];
const BLOCKED_LITERAL_HOSTS = new Set(["169.254.169.254", "100.100.100.200", "fd00:ec2::254"]);
const HTML_CONTENT_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const PLAIN_CONTENT_TYPES = new Set(["text/plain"]);

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const byte = Number(part);
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) return null;
    value = value * 256 + byte;
  }
  return value;
}

function decodeIpv4Literal(host: string): string | null {
  if (/^\d+$/.test(host)) {
    const value = Number(host);
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) return null;
    return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
  }
  const parts = host.split(".");
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
  return bytes.join(".");
}

/** 判断地址是否命中拦截集合。 */
export function isBlockedAddress(address: string): boolean {
  const normalized = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (BLOCKED_LITERAL_HOSTS.has(normalized)) return true;
  if (isIP(normalized) === 4) {
    const value = ipv4ToInt(normalized);
    if (value === null) return true;
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
  if (isIP(normalized) === 6) {
    const lower = normalized.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (/^fe[89ab]/.test(lower)) return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower.startsWith("ff")) return true;
    if (lower.startsWith("2001:db8")) return true;
    return false;
  }
  return true;
}

export function isCloudMetadataHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return CLOUD_METADATA_HOSTS.some((prefix) => lower === prefix.replace(/\.$/, "") || lower.startsWith(prefix));
}

interface ParsedTarget {
  url: URL;
  host: string;
  addresses: string[];
}

function defaultResolveHost(hostname: string): Promise<string[]> {
  return import("node:dns/promises")
    .then((dns) => dns.lookup(hostname, { all: true }))
    .then((records) => records.map((record) => record.address));
}

export function defaultLinkFetcher(
  url: string,
  init: { signal: AbortSignal; redirect: "manual"; dispatcher?: unknown; headers?: Record<string, string> },
): Promise<LinkFetchResponse> {
  return fetch(url, init as RequestInit) as unknown as Promise<LinkFetchResponse>;
}

export function createLinkSourceProvider(deps: LinkSourceProviderDeps = {}): DatasetSourceProvider {
  const limits: LinkLimits = { ...DEFAULT_LINK_LIMITS, ...deps.limits };
  const fetchImpl: LinkFetcher = deps.fetcher ?? defaultLinkFetcher;
  const resolveHost = deps.resolveHost ?? defaultResolveHost;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.clock ?? (() => Date.now());

  const audit = (entry: Parameters<SourceAuditSink>[0]): void => {
    deps.audit?.(entry);
  };

  const validateAndResolve = async (rawUrl: string, requestId: string): Promise<ParsedTarget> => {
    if (rawUrl.length > limits.maxUrlLength) {
      throw sourceError(501031, requestId, { urlHash: hashUrl(rawUrl), protocol: "length" });
    }
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw sourceError(501031, requestId, { urlHash: hashUrl(rawUrl), protocol: "invalid" });
    }
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
      throw sourceError(501031, requestId, { urlHash: hashUrl(rawUrl), protocol: url.protocol });
    }
    if (url.username.length > 0 || url.password.length > 0) {
      throw sourceError(501031, requestId, { urlHash: hashUrl(rawUrl), protocol: "userinfo" });
    }
    const port = url.port.length > 0 ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    if (!ALLOWED_PORTS.has(port)) {
      throw sourceError(501031, requestId, { urlHash: hashUrl(rawUrl), protocol: "port:" + String(port) });
    }
    const host = normalizeHost(url.hostname);
    if (isCloudMetadataHost(host)) {
      throw sourceError(501032, requestId, { urlHash: hashUrl(rawUrl), reason: "cloud_metadata_host" });
    }
    const literal = decodeIpv4Literal(host);
    if (literal && isBlockedAddress(literal)) {
      throw sourceError(501032, requestId, { urlHash: hashUrl(rawUrl), reason: "literal_address" });
    }
    if (isIP(host) !== 0 && isBlockedAddress(host)) {
      throw sourceError(501032, requestId, { urlHash: hashUrl(rawUrl), reason: "literal_address" });
    }
    let addresses: string[];
    if (isIP(host) !== 0) addresses = [host];
    else addresses = await resolveHost(host);
    if (addresses.length === 0) {
      throw sourceError(501032, requestId, { urlHash: hashUrl(rawUrl), reason: "dns_empty" });
    }
    for (const address of addresses) {
      if (isBlockedAddress(address)) {
        throw sourceError(501032, requestId, { urlHash: hashUrl(rawUrl), reason: "dns_blocked" });
      }
    }
    return { url, host, addresses };
  };

  const dispatch = async (
    target: ParsedTarget,
  ): Promise<{ status: number; headers: LinkFetchResponse["headers"]; body: string; contentType: string }> => {
    const controller = new AbortController();
    const totalTimer = setTimeout(() => controller.abort(), limits.totalTimeoutMs);
    const dispatcher = createPinnedDispatcher(target.addresses[0] ?? "0.0.0.0", limits.connectTimeoutMs);
    try {
      const response = await fetchImpl(target.url.toString(), {
        signal: controller.signal,
        redirect: "manual",
        dispatcher,
        headers: { accept: "text/html,application/xhtml+xml,text/plain" },
      });
      const contentType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
      const text = await response.text();
      return { status: response.status, headers: response.headers, body: text, contentType };
    } finally {
      clearTimeout(totalTimer);
      void (dispatcher as { close(): Promise<void> }).close();
    }
  };

  const read = async (request: SourceReadRequest, context: RequestContext): Promise<SourceReadResult> => {
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
        if (error instanceof Error && error.name === "ApiErrorException") {
          audit({ event: "source.blocked", urlHash: hashUrl(currentUrl), host: safeHost(currentUrl), outcome: "blocked" });
        }
        throw error;
      }
      let response: { status: number; headers: LinkFetchResponse["headers"]; body: string; contentType: string };
      try {
        response = await dispatch(target);
      } catch (error) {
        if (attempt < limits.retryBackoffMs.length && isTimeout(error)) {
          await sleep(limits.retryBackoffMs[attempt] ?? 0);
          attempt += 1;
          continue;
        }
        audit({ event: "source.failed", urlHash: hashUrl(currentUrl), host: target.host, outcome: "timeout" });
        throw sourceError(501034, requestId, { urlHash: hashUrl(currentUrl), timeoutMs: limits.totalTimeoutMs });
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          throw sourceError(501033, requestId, { urlHash: hashUrl(currentUrl), hops: redirects });
        }
        redirects += 1;
        if (redirects > limits.maxRedirects) {
          throw sourceError(501033, requestId, { urlHash: hashUrl(currentUrl), hops: redirects });
        }
        const next = new URL(location, target.url);
        if (target.url.protocol === "https:" && next.protocol === "http:") {
          throw sourceError(501031, requestId, { urlHash: hashUrl(next.toString()), protocol: "https_downgrade" });
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
        audit({ event: "source.failed", urlHash: hashUrl(currentUrl), host: target.host, outcome: "http_" + String(response.status) });
        throw sourceError(501034, requestId, { urlHash: hashUrl(currentUrl), timeoutMs: limits.totalTimeoutMs });
      }
      if (response.status >= 400) {
        audit({ event: "source.failed", urlHash: hashUrl(currentUrl), host: target.host, outcome: "http_" + String(response.status) });
        throw sourceError(501039, requestId, { provider: "link", status: response.status });
      }

      const allowed = HTML_CONTENT_TYPES.has(response.contentType) || PLAIN_CONTENT_TYPES.has(response.contentType);
      if (!allowed) {
        audit({ event: "source.failed", urlHash: hashUrl(currentUrl), host: target.host, outcome: "content_type" });
        throw sourceError(501035, requestId, { contentType: response.contentType, urlHash: hashUrl(currentUrl) });
      }
      const bytes = Buffer.byteLength(response.body, "utf8");
      if (bytes > limits.maxBytes) {
        audit({ event: "source.failed", urlHash: hashUrl(currentUrl), host: target.host, outcome: "size" });
        throw sourceError(501065, requestId, { limitBytes: limits.maxBytes, actualBytes: bytes, urlHash: hashUrl(currentUrl) });
      }

      const isHtml = HTML_CONTENT_TYPES.has(response.contentType);
      const rawText = isHtml ? htmlToMarkdown(response.body, target.url) : response.body;
      const plain = isHtml ? stripTags(response.body) : response.body;
      const ratio = plain.length === 0 ? 0 : Math.min(1, plain.replace(/\s/g, "").length / Math.max(1, bytes));
      if (plain.trim().length === 0 || ratio < limits.minTextRatio) {
        audit({ event: "source.failed", urlHash: hashUrl(currentUrl), host: target.host, outcome: "empty_content" });
        throw sourceError(501036, requestId, { urlHash: hashUrl(currentUrl), textRatio: ratio });
      }
      audit({ event: "source.read", urlHash: hashUrl(currentUrl), host: target.host, outcome: "ok" });
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
        const cb = callback as unknown as (err: NodeJS.ErrnoException | null, address: string, family: number) => void;
        cb(null, address, isIP(address));
      },
    },
  });
}

function isTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as Record<string, unknown>;
  return record.name === "AbortError" || record.name === "TimeoutError" || record.code === "UND_ERR_CONNECT_TIMEOUT";
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function stripTags(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "\u0027")
    .replace(/&apos;/gi, "\u0027")
    .replace(/&amp;/gi, "&");
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
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|nav|noscript|template)[\s\S]*?<\/\1>/gi, "")
    .replace(/<(script|style|nav|noscript|template)[^>]*\/?>/gi, "");
  html = html
    .replace(/<a\b[^>]*href\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const target = base ? absolutize(href, base) : href;
      return "[" + stripTags(label).trim() + "](" + target + ")";
    })
    .replace(/<img\b[^>]*alt\s*=\s*"([^"]*)"[^>]*src\s*=\s*"([^"]+)"[^>]*\/?>/gi, (_m, alt: string, src: string) => {
      const target = base ? absolutize(src, base) : src;
      return "![" + alt + "](" + target + ")";
    });
  for (let level = 6; level >= 1; level -= 1) {
    const pattern = new RegExp("<h" + String(level) + "[^>]*>([\\s\\S]*?)<\\/h" + String(level) + ">", "gi");
    html = html.replace(pattern, (_m, content: string) => "\n" + "#".repeat(level) + " " + stripTags(content).trim() + "\n");
  }
  html = html
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, content: string) => "\n- " + stripTags(content).trim())
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, content: string) => "\n```\n" + decodeEntities(stripTags(content)).trim() + "\n```\n")
    .replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_m, row: string) => {
      const cells = [...row.matchAll(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)].map((cell) =>
        stripTags(cell[1] ?? "").trim().replace(/\|/g, "\\|"),
      );
      return "\n| " + cells.join(" | ") + " |";
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|ul|ol|table)>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(html)
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
