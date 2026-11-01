#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const TARGETS = Object.freeze([
  {
    kind: 'llm',
    env: 'S11_AIPROXY_LLM_MODEL',
    target: 'deepseek-v4.1-flash',
    hints: ['deepseek'],
  },
  {
    kind: 'embedding',
    env: 'S11_AIPROXY_EMBEDDING_MODEL',
    target: 'bge-large-zh-v1.5',
    hints: ['bge', 'large', 'zh'],
  },
  {
    kind: 'rerank',
    env: 'S11_AIPROXY_RERANK_MODEL',
    target: 'bge-reranker-v2-m3',
    hints: ['bge', 'rerank'],
  },
  {
    kind: 'vlm',
    env: 'S11_AIPROXY_VLM_MODEL',
    target: 'kimi-k2.5',
    hints: ['kimi'],
  },
  {
    kind: 'vision-embedding',
    env: 'S11_AIPROXY_VISION_EMBEDDING_MODEL',
    target: 'qwen-vision-embedding',
    hints: ['qwen', 'vision', 'embedding'],
  },
]);

function valueOf(env, name) {
  return env[name]?.trim() ?? '';
}

function endpointHostHash(endpoint) {
  try {
    return createHash('sha256').update(new URL(endpoint).host).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

export function catalogUrl(baseUrl) {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, '');
  url.pathname = basePath.endsWith('/v1') ? `${basePath}/models` : `${basePath}/v1/models`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function modelId(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const value = entry.id ?? entry.model;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function safeModel(entry) {
  const id = modelId(entry);
  if (!id) return null;
  const type = typeof entry.type === 'string' ? entry.type : null;
  const dimension =
    typeof entry.dimension === 'number' && Number.isInteger(entry.dimension)
      ? entry.dimension
      : null;
  const capabilities = Array.isArray(entry.capabilities)
    ? entry.capabilities.filter((item) => typeof item === 'string').slice(0, 32)
    : [];
  return { id, type, dimension, capabilities };
}

function candidateIds(models, hints) {
  const normalized = hints.map((hint) => hint.toLowerCase());
  return models
    .filter((model) => {
      const id = model.id.toLowerCase();
      return normalized.every((hint) => id.includes(hint));
    })
    .map((model) => model.id)
    .slice(0, 20);
}

export async function probeCatalog(env = process.env, fetcher = globalThis.fetch) {
  const baseUrl = valueOf(env, 'AIPROXY_BASE_URL');
  const token = valueOf(env, 'AIPROXY_API_TOKEN');
  const hostHash = endpointHostHash(baseUrl);
  if (!baseUrl || !hostHash || !token) {
    return {
      status: 'SCOPED_BLOCKED',
      code: 'AIPROXY_CATALOG_INPUT_BLOCKED',
      missingFields: [
        ...(!baseUrl ? ['AIPROXY_BASE_URL'] : []),
        ...(!hostHash ? ['AIPROXY_BASE_URL.validHttpUrl'] : []),
        ...(!token ? ['AIPROXY_API_TOKEN'] : []),
      ],
      endpointHostHash: hostHash,
    };
  }

  let response;
  try {
    response = await fetcher(catalogUrl(baseUrl), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: globalThis.AbortSignal.timeout(15_000),
    });
  } catch {
    return {
      status: 'SCOPED_BLOCKED',
      code: 'AIPROXY_CATALOG_UNAVAILABLE',
      reason: 'network_or_timeout',
      endpointHostHash: hostHash,
    };
  }
  if (!response.ok) {
    return {
      status: 'SCOPED_BLOCKED',
      code: 'AIPROXY_CATALOG_UNAVAILABLE',
      reason: 'http_status',
      upstreamStatus: response.status,
      endpointHostHash: hostHash,
    };
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    return {
      status: 'SCOPED_BLOCKED',
      code: 'AIPROXY_CATALOG_CONTRACT_INVALID',
      reason: 'invalid_json',
      endpointHostHash: hostHash,
    };
  }
  if (!payload || !Array.isArray(payload.data)) {
    return {
      status: 'SCOPED_BLOCKED',
      code: 'AIPROXY_CATALOG_CONTRACT_INVALID',
      reason: 'data_array_required',
      endpointHostHash: hostHash,
    };
  }

  const models = payload.data.map(safeModel).filter((model) => model !== null);
  const mappings = TARGETS.map((target) => {
    const configured = valueOf(env, target.env);
    const exact = models.some((model) => model.id === target.target);
    const candidates = exact ? [target.target] : candidateIds(models, target.hints);
    return {
      kind: target.kind,
      variable: target.env,
      target: target.target,
      configured: configured || null,
      exact,
      candidates,
      approved: false,
    };
  });
  return {
    status: 'READY',
    code: 'AIPROXY_CATALOG_READY',
    endpointHostHash: hostHash,
    modelCount: models.length,
    models,
    mappings,
    requiresUserConfirmation: mappings.some((mapping) => !mapping.exact),
  };
}

export async function main(env = process.env) {
  const result = await probeCatalog(env);
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'READY') {
    console.error(result.code);
    return 2;
  }
  if (result.requiresUserConfirmation) {
    console.error('AIPROXY_MODEL_ALIAS_CONFIRMATION_REQUIRED');
    return 3;
  }
  console.log('AIPROXY_CATALOG_PASS');
  return 0;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exit(await main());
