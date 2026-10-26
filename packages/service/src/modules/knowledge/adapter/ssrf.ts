import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createKnowledgeError } from '@kb/contracts';
import ipaddr from 'ipaddr.js';

export interface VettedUrlTarget {
  url: URL;
  address: string;
  family: 4 | 6;
  addresses: readonly string[];
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
  'instance-data',
]);

function invalid(context: { requestId: string; traceId: string }, reason: string): never {
  throw createKnowledgeError({
    code: 'KNOWLEDGE_UNSUPPORTED_CONTENT',
    requestId: context.requestId,
    traceId: context.traceId,
    details: { reason, field: 'url' },
  });
}

export function isForbiddenAddress(value: string): boolean {
  const parsed = ipaddr.parse(value);
  if (parsed.kind() === 'ipv6') {
    const ipv6 = parsed as ipaddr.IPv6;
    if (ipv6.isIPv4MappedAddress()) {
      return isForbiddenAddress(ipv6.toIPv4Address().toString());
    }
  }
  return parsed.range() !== 'unicast';
}

export function validateUrlSyntax(
  raw: string,
  context: { requestId: string; traceId: string },
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return invalid(context, 'url_invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return invalid(context, 'protocol_not_allowed');
  }
  if (url.username || url.password) return invalid(context, 'userinfo_not_allowed');
  if (!url.hostname) return invalid(context, 'hostname_required');
  if (BLOCKED_HOSTNAMES.has(url.hostname.toLowerCase())) {
    return invalid(context, 'private_address');
  }
  const normalizedHost = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(normalizedHost) && isForbiddenAddress(normalizedHost)) {
    return invalid(context, 'private_address');
  }
  return url;
}

export async function validateUrlTarget(
  raw: string,
  context: { requestId: string; traceId: string },
  resolver: typeof lookup = lookup,
): Promise<VettedUrlTarget> {
  const url = validateUrlSyntax(raw, context);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: Array<{ address: string; family: number }>;
  if (isIP(hostname)) {
    addresses = [{ address: hostname, family: isIP(hostname) }];
  } else {
    try {
      addresses = await resolver(hostname, { all: true, verbatim: true });
    } catch {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { dependency: 'dns', hostname },
      });
    }
  }
  if (addresses.length === 0 || addresses.some((entry) => isForbiddenAddress(entry.address))) {
    return invalid(context, 'private_address');
  }
  const selected = addresses[0];
  if (!selected || (selected.family !== 4 && selected.family !== 6)) {
    return invalid(context, 'address_family_invalid');
  }
  return {
    url,
    address: selected.address,
    family: selected.family,
    addresses: addresses.map((entry) => entry.address),
  };
}

export function safeUrlForStorage(raw: string): string {
  const url = new URL(raw);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString();
}
