#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const REQUIRED_PROVIDER_ENV = Object.freeze({
  aiproxy: [
    'AIPROXY_MODE',
    'AIPROXY_BASE_URL',
    'AIPROXY_API_TOKEN',
    'S11_AIPROXY_LLM_MODEL',
    'S11_AIPROXY_EMBEDDING_MODEL',
    'S11_AIPROXY_RERANK_MODEL',
    'S11_AIPROXY_VLM_MODEL',
    'S11_AIPROXY_VISION_EMBEDDING_MODEL',
  ],
  'ocr-sangfor': ['S11_OCR_SANGFOR_PROFILE_JSON'],
  'ocr-somark': ['S11_OCR_SOMARK_PROFILE_JSON'],
  'ocr-textin': ['S11_OCR_TEXTIN_PROFILE_JSON'],
  'ocr-doc2x': ['S11_OCR_DOC2X_PROFILE_JSON'],
  feishu: [
    'S11_FEISHU_APP_ID',
    'S11_FEISHU_APP_SECRET',
    'S11_FEISHU_FOLDER_TOKEN',
    'S11_FEISHU_DOC_1',
    'S11_FEISHU_DOC_2',
  ],
  yuque: [
    'S11_YUQUE_USER_ID',
    'S11_YUQUE_TOKEN',
    'S11_YUQUE_BASE_URL',
    'S11_YUQUE_BASE_PATH',
    'S11_YUQUE_REPO_ID',
    'S11_YUQUE_TOC_ID',
    'S11_YUQUE_DOC_1',
    'S11_YUQUE_DOC_2',
  ],
  dingtalk: [
    'S11_DINGTALK_APP_KEY',
    'S11_DINGTALK_APP_SECRET',
    'S11_DINGTALK_USER_ID',
    'S11_DINGTALK_OPERATOR_ID',
    'S11_DINGTALK_WORKSPACE_ID',
    'S11_DINGTALK_ROOT_NODE_ID',
    'S11_DINGTALK_DOC_1',
    'S11_DINGTALK_DOC_2',
  ],
});

export const PROVIDER_SCOPE_PROFILES = Object.freeze({
  'canonical-v1': Object.freeze({
    requiredProviders: Object.freeze(Object.keys(REQUIRED_PROVIDER_ENV)),
    deferredProviders: Object.freeze([]),
    requiresModelMappingApproval: false,
  }),
  'knowledge-usability-v1': Object.freeze({
    requiredProviders: Object.freeze([
      'aiproxy',
      'ocr-somark',
      'ocr-textin',
      'ocr-doc2x',
      'feishu',
    ]),
    deferredProviders: Object.freeze(['ocr-sangfor', 'yuque', 'dingtalk']),
    requiresModelMappingApproval: true,
  }),
});

const OCR_PROVIDERS = new Set(['ocr-sangfor', 'ocr-somark', 'ocr-textin', 'ocr-doc2x']);

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

function profileFailure(provider, raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { missingFields: [], invalidFields: ['endpoint'], endpointHostHash: null };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { missingFields: [], invalidFields: ['endpoint'], endpointHostHash: null };
  }
  const endpoint =
    typeof value.endpoint === 'string' && value.endpoint.length > 0 ? value.endpoint : null;
  const credentials =
    value.credentials && typeof value.credentials === 'object' && !Array.isArray(value.credentials)
      ? value.credentials
      : null;
  const expectedFields =
    provider === 'ocr-textin'
      ? ['appId', 'secretCode']
      : provider === 'ocr-sangfor'
        ? ['token']
        : ['apiKey'];
  const invalidFields = [];
  if (!endpoint) invalidFields.push('endpoint');
  if (!credentials) invalidFields.push('credentials');
  if (credentials) {
    for (const field of expectedFields) {
      if (typeof credentials[field] !== 'string' || credentials[field].trim() === '') {
        invalidFields.push(`credentials.${field}`);
      }
    }
  }
  return {
    missingFields: [],
    invalidFields,
    endpointHostHash: endpointHostHash(endpoint),
  };
}

export function checkEnvironment(env = process.env) {
  const providers = [];
  const scopeProfileName = valueOf(env, 'S11_SCOPE_PROFILE') || 'canonical-v1';
  const scopeProfile = PROVIDER_SCOPE_PROFILES[scopeProfileName];
  if (!scopeProfile) {
    return {
      status: 'BLOCKED',
      scopeProfile: scopeProfileName,
      mode: valueOf(env, 'S11_PROVIDER_MODE') || null,
      profileVersion: 's11-provider-inputs-v1',
      providers: [],
      missingFields: ['S11_SCOPE_PROFILE'],
      invalidFields: [],
      deferredProviders: [],
    };
  }
  if (valueOf(env, 'S11_PROVIDER_MODE') !== 'real') {
    providers.push({
      provider: 'mode',
      status: 'BLOCKED',
      missingFields: ['S11_PROVIDER_MODE=real'],
      invalidFields: [],
      endpointHostHash: null,
      modelIds: [],
      profileVersion: 's11-provider-inputs-v1',
    });
  } else {
    providers.push({
      provider: 'mode',
      status: 'READY',
      missingFields: [],
      invalidFields: [],
      endpointHostHash: null,
      modelIds: [],
      profileVersion: 's11-provider-inputs-v1',
    });
  }
  for (const [provider, names] of Object.entries(REQUIRED_PROVIDER_ENV)) {
    if (scopeProfile.deferredProviders.includes(provider)) {
      providers.push({
        provider,
        status: 'DEFERRED_BY_SCOPE',
        missingFields: [],
        invalidFields: [],
        endpointHostHash: null,
        modelIds: [],
        profileVersion: 's11-provider-inputs-v1',
      });
      continue;
    }
    const missingFields = names.filter((name) => !valueOf(env, name));
    let invalidFields = [];
    let hostHash = null;
    if (provider === 'aiproxy') {
      hostHash = endpointHostHash(valueOf(env, 'AIPROXY_BASE_URL'));
      if (
        valueOf(env, 'AIPROXY_MODE') &&
        !['compose', 'external', 'openai'].includes(valueOf(env, 'AIPROXY_MODE'))
      ) {
        invalidFields.push('AIPROXY_MODE');
      }
      if (
        scopeProfile.requiresModelMappingApproval &&
        valueOf(env, 'S11_AIPROXY_MODEL_MAPPING_APPROVED') !== 'true'
      ) {
        missingFields.push('S11_AIPROXY_MODEL_MAPPING_APPROVED');
      }
    } else if (OCR_PROVIDERS.has(provider) && missingFields.length === 0) {
      const result = profileFailure(provider, valueOf(env, names[0]));
      invalidFields = result.invalidFields;
      hostHash = result.endpointHostHash;
    } else if (provider === 'yuque') {
      hostHash = endpointHostHash(valueOf(env, 'S11_YUQUE_BASE_URL'));
      if (valueOf(env, 'S11_YUQUE_BASE_URL') && !hostHash) {
        invalidFields.push('S11_YUQUE_BASE_URL');
      }
    } else if (provider === 'feishu') {
      hostHash = endpointHostHash('https://open.feishu.cn');
    } else if (provider === 'dingtalk') {
      hostHash = endpointHostHash('https://api.dingtalk.com');
    }
    providers.push({
      provider,
      status: missingFields.length === 0 && invalidFields.length === 0 ? 'READY' : 'BLOCKED',
      missingFields,
      invalidFields,
      endpointHostHash: hostHash,
      modelIds:
        provider === 'aiproxy'
          ? [
              valueOf(env, 'S11_AIPROXY_LLM_MODEL'),
              valueOf(env, 'S11_AIPROXY_EMBEDDING_MODEL'),
              valueOf(env, 'S11_AIPROXY_RERANK_MODEL'),
              valueOf(env, 'S11_AIPROXY_VLM_MODEL'),
              valueOf(env, 'S11_AIPROXY_VISION_EMBEDDING_MODEL'),
            ].filter(Boolean)
          : [],
      profileVersion: 's11-provider-inputs-v1',
    });
  }
  const required = new Set(scopeProfile.requiredProviders);
  const requiredProviders = providers.filter(
    (provider) => provider.provider !== 'mode' && required.has(provider.provider),
  );
  const ready =
    providers.find((provider) => provider.provider === 'mode')?.status === 'READY' &&
    requiredProviders.every((provider) => provider.status === 'READY');
  return {
    status: ready
      ? 'READY'
      : scopeProfileName === 'knowledge-usability-v1'
        ? 'SCOPED_BLOCKED'
        : 'BLOCKED',
    scopeProfile: scopeProfileName,
    mode: valueOf(env, 'S11_PROVIDER_MODE') || null,
    profileVersion: 's11-provider-inputs-v1',
    providers,
    missingFields: providers
      .filter((provider) => provider.status !== 'DEFERRED_BY_SCOPE')
      .flatMap((provider) => provider.missingFields),
    invalidFields: providers
      .filter((provider) => provider.status !== 'DEFERRED_BY_SCOPE')
      .flatMap((provider) =>
        provider.invalidFields.map((field) => `${provider.provider}.${field}`),
      ),
    deferredProviders: [...scopeProfile.deferredProviders],
  };
}

export function safeProviderSummary(env = process.env) {
  const result = checkEnvironment(env);
  return {
    status: result.status,
    scopeProfile: result.scopeProfile,
    mode: result.mode,
    profileVersion: result.profileVersion,
    providers: result.providers.map((provider) => ({
      provider: provider.provider,
      status: provider.status,
      missingFields: provider.missingFields,
      invalidFields: provider.invalidFields,
      endpointHostHash: provider.endpointHostHash,
      modelIds: provider.modelIds,
      profileVersion: provider.profileVersion,
    })),
    missingFields: result.missingFields,
    invalidFields: result.invalidFields,
    deferredProviders: result.deferredProviders,
  };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (!process.argv.slice(2).every((arg) => arg === '--json')) {
    console.error('PROVIDER_INPUT_INVALID: only --json is supported');
    process.exit(1);
  }
  const result = safeProviderSummary();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.status} ${result.providers.length} providers`);
  }
  if (result.status !== 'READY') {
    console.error(
      `${result.status === 'SCOPED_BLOCKED' ? 'SCOPED_BLOCKED' : 'PROVIDER_BLOCKED'}: ${result.missingFields.length + result.invalidFields.length}`,
    );
    process.exit(2);
  }
}
