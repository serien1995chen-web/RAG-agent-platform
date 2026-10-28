import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerKnowledgeModels } from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import { createKnowledgeConnections } from '../../packages/service/src/shared/runtime/knowledge-connections';
import { messages } from '../../packages/web/src/i18n/messages';

type JsonObject = Record<string, unknown>;

interface RuntimeOperation {
  operationId: string;
  method: string;
  path: string;
  idempotent: boolean;
}

interface RuntimeRegistry {
  count: number;
  operations: RuntimeOperation[];
}

interface OpenApiOperation {
  requestBody?: {
    content?: Record<string, { schema?: unknown }>;
  };
  responses: Record<
    string,
    {
      content?: Record<string, { schema?: unknown }>;
    }
  >;
}

interface OpenApiDocument {
  openapi: string;
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: { schemas: Record<string, unknown> };
}

interface ApiCallOptions {
  params?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

const repositoryRoot = resolve(import.meta.dirname, '../..');
const appRoot = join(repositoryRoot, 'projects', 'app');
const runtimeRegistry = JSON.parse(
  readFileSync(
    join(repositoryRoot, 'packages', 'contracts', 'src', 'openapi', 'runtime-registry.data.json'),
    'utf8',
  ),
) as RuntimeRegistry;
const openApiDocument = JSON.parse(
  readFileSync(
    join(repositoryRoot, 'packages', 'contracts', 'openapi', 'knowledge-target.openapi.json'),
    'utf8',
  ),
) as OpenApiDocument;
const runtimeById = new Map(
  runtimeRegistry.operations.map((operation) => [operation.operationId, operation]),
);
const rawMessageKeyPrefixes = [
  ...new Set(Object.keys(messages['zh-CN']).map((key) => key.slice(0, key.indexOf('.')))),
];
const rawMessageKeyPattern = new RegExp(
  `\\b(?:${rawMessageKeyPrefixes
    .map((prefix) => prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})\\.`,
);

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_e2e_${suffix}`;
const memberId = `mem_e2e_owner_${suffix}`;
const authToken = `kb-e2e-token-${suffix}`;
const covered = new Set<string>();

let appProcess: ChildProcess | undefined;
let baseUrl = '';
let serverOutput = '';
let requestSequence = 0;
let connections: Awaited<ReturnType<typeof createKnowledgeConnections>> | undefined;

const scenario: {
  spaceId?: string;
  directoryId?: string;
  sourceId?: string;
  segmentId?: string;
  tagId?: string;
  sourceDeleteJobId?: string;
  blobId?: string;
  archiveJobId?: string;
} = {};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required e2e environment: ${name}`);
  return value;
}

function asObject(value: unknown): JsonObject {
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);
  expect(typeof value).toBe('object');
  return value as JsonObject;
}

function asNumber(value: unknown, field: string): number {
  expect(typeof value, field).toBe('number');
  return value as number;
}

function asString(value: unknown, field: string): string {
  expect(typeof value, field).toBe('string');
  return value as string;
}

function requiredId(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} was not initialized`);
  return value;
}

function resolvePointer(reference: string): unknown {
  if (!reference.startsWith('#/')) return undefined;
  return reference
    .slice(2)
    .split('/')
    .reduce<unknown>((current, segment) => {
      if (current === null || typeof current !== 'object') return undefined;
      const key = segment.replaceAll('~1', '/').replaceAll('~0', '~');
      return (current as JsonObject)[key];
    }, openApiDocument);
}

function valueMatchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'array':
      return Array.isArray(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'null':
      return value === null;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    default:
      return true;
  }
}

function schemaProblems(value: unknown, schema: unknown, path = '$'): string[] {
  if (schema === true || schema === undefined) return [];
  if (schema === false) return [`${path}: schema=false`];
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return [];

  const definition = schema as JsonObject;
  if (typeof definition.$ref === 'string') {
    const resolved = resolvePointer(definition.$ref);
    if (resolved === undefined) return [`${path}: unresolved reference ${definition.$ref}`];
    return schemaProblems(value, resolved, path);
  }

  for (const keyword of ['oneOf', 'anyOf'] as const) {
    if (Array.isArray(definition[keyword])) {
      const candidates = definition[keyword] as unknown[];
      const matches = candidates.filter(
        (candidate) => schemaProblems(value, candidate, path).length === 0,
      );
      if (matches.length === 0) return [`${path}: no ${keyword} branch matched`];
      if (keyword === 'oneOf' && matches.length !== 1) {
        return [`${path}: ${matches.length} oneOf branches matched`];
      }
      if (matches.length === 1) return schemaProblems(value, matches[0], path);
    }
  }

  const problems: string[] = [];
  if (definition.const !== undefined && value !== definition.const) {
    problems.push(`${path}: expected const ${JSON.stringify(definition.const)}`);
  }
  if (Array.isArray(definition.enum) && !definition.enum.includes(value)) {
    problems.push(`${path}: value is not in enum`);
  }

  const allowedTypes = Array.isArray(definition.type)
    ? (definition.type as string[])
    : typeof definition.type === 'string'
      ? [definition.type]
      : [];
  if (allowedTypes.length > 0 && !allowedTypes.some((type) => valueMatchesType(value, type))) {
    return [`${path}: expected type ${allowedTypes.join('|')}`];
  }

  if (typeof value === 'string') {
    if (typeof definition.minLength === 'number' && value.length < definition.minLength) {
      problems.push(`${path}: shorter than minLength`);
    }
    if (typeof definition.maxLength === 'number' && value.length > definition.maxLength) {
      problems.push(`${path}: longer than maxLength`);
    }
    if (typeof definition.pattern === 'string' && !new RegExp(definition.pattern).test(value)) {
      problems.push(`${path}: does not match pattern`);
    }
    if (definition.format === 'date-time' && Number.isNaN(Date.parse(value))) {
      problems.push(`${path}: invalid date-time`);
    }
  }

  if (typeof value === 'number') {
    if (typeof definition.minimum === 'number' && value < definition.minimum) {
      problems.push(`${path}: below minimum`);
    }
    if (typeof definition.maximum === 'number' && value > definition.maximum) {
      problems.push(`${path}: above maximum`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof definition.minItems === 'number' && value.length < definition.minItems) {
      problems.push(`${path}: fewer than minItems`);
    }
    if (typeof definition.maxItems === 'number' && value.length > definition.maxItems) {
      problems.push(`${path}: more than maxItems`);
    }
    if (definition.uniqueItems === true) {
      const unique = new Set(value.map((item) => JSON.stringify(item)));
      if (unique.size !== value.length) problems.push(`${path}: array items are not unique`);
    }
    if (definition.items !== undefined) {
      value.forEach((item, index) => {
        problems.push(...schemaProblems(item, definition.items, `${path}[${index}]`));
      });
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as JsonObject;
    const required = Array.isArray(definition.required) ? (definition.required as string[]) : [];
    for (const field of required) {
      if (!(field in record)) problems.push(`${path}.${field}: required field is missing`);
    }
    const properties =
      definition.properties !== null &&
      typeof definition.properties === 'object' &&
      !Array.isArray(definition.properties)
        ? (definition.properties as JsonObject)
        : {};
    for (const [key, child] of Object.entries(record)) {
      if (properties[key] !== undefined) {
        problems.push(...schemaProblems(child, properties[key], `${path}.${key}`));
      } else if (definition.additionalProperties === false) {
        problems.push(`${path}.${key}: additional property is forbidden`);
      } else if (
        definition.additionalProperties !== null &&
        typeof definition.additionalProperties === 'object'
      ) {
        problems.push(...schemaProblems(child, definition.additionalProperties, `${path}.${key}`));
      }
    }
  }

  return problems;
}

function requestSchemaFor(operation: RuntimeOperation): unknown {
  const contractOperation = openApiDocument.paths[operation.path]?.[operation.method.toLowerCase()];
  return contractOperation?.requestBody?.content?.['application/json']?.schema;
}

function successResponseFor(operation: RuntimeOperation, status: number): { schema?: unknown } {
  const contractOperation = openApiDocument.paths[operation.path]?.[operation.method.toLowerCase()];
  const response = contractOperation?.responses[String(status)];
  if (!response) throw new Error(`${operation.operationId} has no contract response for ${status}`);
  return response;
}

function concretePath(path: string, params: Record<string, string>): string {
  return path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = params[name];
    if (!value) throw new Error(`missing path parameter ${name}`);
    return encodeURIComponent(value);
  });
}

async function callApi(operationId: string, options: ApiCallOptions = {}): Promise<unknown> {
  const operation = runtimeById.get(operationId);
  if (!operation) throw new Error(`operation is not in runtime registry: ${operationId}`);
  const params = options.params ?? {};
  const path = concretePath(operation.path, params);
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) query.set(key, String(value));
  }
  const queryString = query.size > 0 ? `?${query.toString()}` : '';

  const requestSchema = requestSchemaFor(operation);
  const requestBody = options.body;
  if (requestBody !== undefined && requestSchema !== undefined) {
    expect(
      schemaProblems(requestBody, requestSchema),
      `${operationId} request body contract`,
    ).toEqual([]);
  }

  requestSequence += 1;
  const headers: Record<string, string> = {
    authorization: `Bearer ${authToken}`,
    'x-workspace-id': workspaceId,
    'x-request-id': `req_e2e_${suffix}_${requestSequence}`,
    traceparent: `00-${suffix.padEnd(32, '0').slice(0, 32)}-${String(requestSequence).padStart(16, '0')}-01`,
  };
  if (requestBody !== undefined) headers['content-type'] = 'application/json';
  if (operation.idempotent && !['GET', 'HEAD'].includes(operation.method)) {
    headers['idempotency-key'] = `idem-e2e-${suffix}-${String(requestSequence).padStart(4, '0')}`;
  }

  const response = await fetch(`${baseUrl}${path}${queryString}`, {
    method: operation.method,
    headers,
    ...(requestBody !== undefined ? { body: JSON.stringify(requestBody) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const bodyText = await response.text();
  expect(
    [200, 201, 202, 204].includes(response.status),
    `${operationId} returned ${response.status}: ${bodyText}`,
  ).toBe(true);

  if (response.status === 204) {
    expect(bodyText, `${operationId} 204 body`).toBe('');
    covered.add(operationId);
    return null;
  }

  const payload = JSON.parse(bodyText) as unknown;
  const responseDefinition = successResponseFor(operation, response.status);
  const responseSchema = responseDefinition.content?.['application/json']?.schema;
  expect(schemaProblems(payload, responseSchema), `${operationId} response contract`).toEqual([]);
  const envelope = asObject(payload);
  expect(envelope.success, operationId).toBe(true);
  expect(envelope.requestId, operationId).toEqual(expect.any(String));
  expect(envelope.traceId, operationId).toEqual(expect.any(String));
  covered.add(operationId);
  return envelope.data;
}

async function callBinaryApi(
  operationId: string,
  options: ApiCallOptions & { binary: Uint8Array },
): Promise<unknown> {
  const operation = runtimeById.get(operationId);
  if (!operation) throw new Error(`operation is not in runtime registry: ${operationId}`);
  const path = concretePath(operation.path, options.params ?? {});
  requestSequence += 1;
  const response = await fetch(`${baseUrl}${path}`, {
    method: operation.method,
    headers: {
      authorization: `Bearer ${authToken}`,
      'x-workspace-id': workspaceId,
      'x-request-id': `req_e2e_${suffix}_${requestSequence}`,
      'content-type': 'application/octet-stream',
      'idempotency-key': `idem-e2e-${suffix}-${String(requestSequence).padStart(4, '0')}`,
    },
    body: options.binary,
  });
  const text = await response.text();
  expect(response.status, `${operationId}: ${text}`).toBe(200);
  const payload = JSON.parse(text) as {
    success: true;
    data: unknown;
  };
  covered.add(operationId);
  return payload.data;
}

async function availablePort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('unable to allocate test port'));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (appProcess?.exitCode !== null) {
      throw new Error(`Next server exited early (${appProcess?.exitCode})\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // The production server is still compiling/starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Next server did not become healthy\n${serverOutput}`);
}

async function consoleCookie(): Promise<string> {
  const response = await fetch(`${baseUrl}/api/console/session`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${authToken}`,
      'x-workspace-id': workspaceId,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  expect(response.status).toBe(200);
  const setCookie = response.headers.get('set-cookie') ?? '';
  expect(setCookie).toContain('kb_console_session=');
  expect(setCookie).toContain('HttpOnly');
  expect(setCookie).toContain('SameSite=Strict');
  return setCookie.split(';', 1)[0] ?? '';
}

function captureServerOutput(chunk: Buffer): void {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-40_000);
}

async function stopServer(): Promise<void> {
  if (!appProcess || appProcess.exitCode !== null) return;
  const processToStop = appProcess;
  await new Promise<void>((resolveStop) => {
    const timer = setTimeout(() => {
      processToStop.kill('SIGKILL');
      resolveStop();
    }, 10_000);
    processToStop.once('exit', () => {
      clearTimeout(timer);
      resolveStop();
    });
    processToStop.kill('SIGTERM');
  });
}

async function cleanupWorkspace(): Promise<void> {
  if (connections) {
    const models = registerKnowledgeModels(connections.mongo);
    for (const model of Object.values(models)) {
      await model.deleteMany({ workspaceId });
    }
    const keys = [
      ...(await connections.redis.keys(`kb-idem:${workspaceId}:*`)),
      ...(await connections.redis.keys(`kb-rate:${workspaceId}:*`)),
    ];
    if (keys.length > 0) await connections.redis.del(...keys);
    await connections.close();
  }
}

beforeAll(async () => {
  const port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const nextBinary = join(appRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
  if (!existsSync(nextBinary)) throw new Error(`Next binary not found: ${nextBinary}`);

  const buildEnvironment = {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: '1',
  };
  execFileSync(process.execPath, [nextBinary, 'build'], {
    cwd: appRoot,
    env: buildEnvironment,
    stdio: 'inherit',
  });

  const accessKey = requiredEnv('KB_TEST_S3_ACCESS_KEY');
  const secretKey = requiredEnv('KB_TEST_S3_SECRET_KEY');
  const runtimeEnvironment = {
    ...process.env,
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    KB_ENV: 'test',
    KB_APP_WORKER_MODE: 'http',
    KB_PORT: String(port),
    KB_INSTANCE_ID: `e2e-${suffix}`,
    KB_MONGO_URI: requiredEnv('KB_TEST_MONGO_URI'),
    KB_REDIS_URL: requiredEnv('KB_TEST_REDIS_URL'),
    KB_PG_URL: requiredEnv('KB_TEST_PG_URL'),
    KB_S3_ENDPOINT: requiredEnv('KB_TEST_S3_ENDPOINT'),
    KB_S3_REGION: process.env.KB_TEST_S3_REGION ?? 'us-east-1',
    KB_S3_BUCKET: requiredEnv('KB_TEST_S3_BUCKET'),
    KB_S3_ACCESS_KEY_REF: 'env:KB_E2E_S3_ACCESS_KEY',
    KB_S3_SECRET_KEY_REF: 'env:KB_E2E_S3_SECRET_KEY',
    KB_E2E_S3_ACCESS_KEY: accessKey,
    KB_E2E_S3_SECRET_KEY: secretKey,
    KB_FILE_PUBLIC_BASE_URL: baseUrl,
    KB_FILE_TICKET_SECRET_REF: 'env:KB_E2E_FILE_TICKET_SECRET',
    KB_E2E_FILE_TICKET_SECRET: `file-ticket-${suffix}-fixed-secret-value`,
    KB_CREDENTIAL_ENCRYPTION_KEY_REF: 'env:KB_E2E_CREDENTIAL_KEY',
    KB_E2E_CREDENTIAL_KEY: `credential-key-${suffix}-fixed-value-32-bytes`,
    KB_CITATION_SIGNING_SECRET_REF: 'env:KB_E2E_CITATION_SECRET',
    KB_E2E_CITATION_SECRET: `e2e-citation-${suffix}-fixed-secret-value`,
    KB_AUTH_MODE: 'mock',
    KB_MOCK_AUTH_TOKEN: authToken,
    KB_MOCK_WORKSPACE_ID: workspaceId,
    KB_MOCK_MEMBER_ID: memberId,
    KB_MOCK_SCOPES: 'knowledge:read,knowledge:write,knowledge:manage,knowledge:admin',
    KB_MOCK_WORKSPACE_OWNER: 'true',
    KB_EXTERNAL_MODEL_MODE: 'mock',
    KB_EXTERNAL_OCR_MODE: 'mock',
    KB_EXTERNAL_CONNECTOR_MODE: 'mock',
    KB_LOG_LEVEL: 'error',
  };

  appProcess = spawn(process.execPath, [nextBinary, 'start', '-p', String(port)], {
    cwd: appRoot,
    env: runtimeEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  appProcess.stdout?.on('data', captureServerOutput);
  appProcess.stderr?.on('data', captureServerOutput);
  await waitForHealth();

  connections = await createKnowledgeConnections({
    environment: 'test',
    workerMode: 'http',
    port,
    instanceId: `e2e-cleanup-${suffix}`,
    mongoUri: requiredEnv('KB_TEST_MONGO_URI'),
    redisUrl: requiredEnv('KB_TEST_REDIS_URL'),
    pgUrl: requiredEnv('KB_TEST_PG_URL'),
    s3: {
      endpoint: requiredEnv('KB_TEST_S3_ENDPOINT'),
      region: process.env.KB_TEST_S3_REGION ?? 'us-east-1',
      bucket: requiredEnv('KB_TEST_S3_BUCKET'),
      accessKeyRef: 'env:KB_E2E_S3_ACCESS_KEY',
      secretKeyRef: 'env:KB_E2E_S3_SECRET_KEY',
    },
    auth:
      runtimeEnvironment.KB_AUTH_MODE === 'mock'
        ? {
            mode: 'mock',
            fixture: {
              token: authToken,
              workspaceId,
              memberId,
              scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage', 'knowledge:admin'],
              isWorkspaceOwner: true,
            },
          }
        : { mode: 'iam' },
    externalModes: {
      model: 'mock',
      ocr: 'mock',
      connector: 'mock',
    },
    logLevel: 'error',
  });
  registerKnowledgeModels(connections.mongo);
}, 180_000);

afterAll(async () => {
  await stopServer();
  await cleanupWorkspace();
}, 60_000);

describe.sequential('knowledge architecture baseline E2E', () => {
  it('executes the stateful runtime catalog and access paths over HTTP', async () => {
    const health = asObject(await callApi('API-HEALTH-LIVE'));
    expect(health.status).toBe('ok');
    expect(health.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'telemetry', status: 'noop' })]),
    );

    const readiness = asObject(await callApi('API-HEALTH-READY'));
    expect(readiness.status).toBe('ok');
    expect(readiness.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'mongo', status: 'ok' }),
        expect.objectContaining({ name: 'redis', status: 'ok' }),
        expect.objectContaining({ name: 'postgres', status: 'ok' }),
        expect.objectContaining({ name: 's3', status: 'ok' }),
      ]),
    );

    const openapi = asObject(await callApi('API-OPENAPI'));
    expect(openapi.openapi).toBe('3.1.0');
    expect(Object.keys(asObject(openapi.paths))).toHaveLength(92);
    expect(asObject(openapi.components).schemas).toBeDefined();

    await callApi('API-SPACE-LIST', { query: { limit: 200 } });
    const createdSpace = asObject(
      await callApi('API-SPACE-CREATE', {
        body: {
          kind: 'space',
          name: `E2E handbook ${suffix}`,
          description: 'Architecture baseline acceptance',
          iconKey: 'book-open',
          accessMode: 'workspace',
          sourceAclMode: 'enforced',
          sourcePermissionEnabled: true,
        },
      }),
    );
    scenario.spaceId = asString(createdSpace.id, 'space.id');
    const initialSpaceVersion = asNumber(createdSpace.version, 'space.version');
    const fetchedSpace = asObject(
      await callApi('API-SPACE-GET', { params: { spaceId: scenario.spaceId } }),
    );
    expect(fetchedSpace.id).toBe(scenario.spaceId);
    const updatedSpace = asObject(
      await callApi('API-SPACE-UPDATE', {
        params: { spaceId: scenario.spaceId },
        body: {
          version: initialSpaceVersion,
          name: `E2E handbook updated ${suffix}`,
        },
      }),
    );
    expect(updatedSpace.name).toContain('updated');

    await callApi('API-DIRECTORY-LIST', {
      params: { spaceId: scenario.spaceId },
      query: { limit: 200 },
    });
    const createdDirectory = asObject(
      await callApi('API-DIRECTORY-CREATE', {
        params: { spaceId: scenario.spaceId },
        body: { name: `Guides ${suffix}` },
      }),
    );
    scenario.directoryId = asString(createdDirectory.id, 'directory.id');
    const fetchedDirectory = asObject(
      await callApi('API-DIRECTORY-GET', {
        params: { directoryId: scenario.directoryId },
      }),
    );
    const updatedDirectory = asObject(
      await callApi('API-DIRECTORY-UPDATE', {
        params: { directoryId: scenario.directoryId },
        body: { version: asNumber(fetchedDirectory.version, 'directory.version'), name: 'Guides' },
      }),
    );

    await callApi('API-SOURCE-LIST', {
      params: { spaceId: scenario.spaceId },
      query: { limit: 200 },
    });
    const createdSource = asObject(
      await callApi('API-SOURCE-CREATE', {
        params: { spaceId: scenario.spaceId },
        body: {
          kind: 'text',
          directoryId: scenario.directoryId,
          name: `Runtime notes ${suffix}`,
          searchEnabled: true,
          metadata: { e2e: true },
        },
      }),
    );
    scenario.sourceId = asString(createdSource.id, 'source.id');
    await callApi('API-SOURCE-GET', { params: { sourceId: scenario.sourceId } });
    await callApi('API-SOURCE-UPDATE', {
      params: { sourceId: scenario.sourceId },
      body: { version: asNumber(createdSource.version, 'source.version'), name: 'Runtime notes' },
    });

    await callApi('API-SEGMENT-LIST', {
      params: { sourceId: scenario.sourceId },
      query: { limit: 200 },
    });
    const createdSegment = asObject(
      await callApi('API-SEGMENT-CREATE', {
        params: { sourceId: scenario.sourceId },
        body: {
          question: 'How is the baseline verified?',
          answer: 'The production HTTP runtime uses real infrastructure.',
          searchEnabled: true,
          metadata: { section: 'acceptance' },
        },
      }),
    );
    scenario.segmentId = asString(createdSegment.id, 'segment.id');
    await callApi('API-SEGMENT-GET', { params: { segmentId: scenario.segmentId } });
    await callApi('API-SEGMENT-UPDATE', {
      params: { segmentId: scenario.segmentId },
      body: {
        version: asNumber(createdSegment.version, 'segment.version'),
        answer: 'The production HTTP runtime uses real Mongo, Redis, pgvector and MinIO.',
      },
    });

    await callApi('API-TAG-LIST', {
      params: { spaceId: scenario.spaceId },
      query: { limit: 200 },
    });
    const createdTag = asObject(
      await callApi('API-TAG-CREATE', {
        params: { spaceId: scenario.spaceId },
        body: {
          key: `e2e_stage_${suffix.slice(0, 5)}`,
          label: 'Release stage',
          tagType: 'string',
          required: false,
          options: ['draft', 'approved'],
        },
      }),
    );
    scenario.tagId = asString(createdTag.id, 'tag.id');
    await callApi('API-TAG-GET', { params: { tagId: scenario.tagId } });
    const updatedTag = asObject(
      await callApi('API-TAG-UPDATE', {
        params: { tagId: scenario.tagId },
        body: {
          version: asNumber(createdTag.version, 'tag.version'),
          label: 'Release stage updated',
        },
      }),
    );
    const valuesTag = asObject(
      await callApi('API-TAG-VALUES', {
        params: { tagId: scenario.tagId },
        body: {
          version: asNumber(updatedTag.version, 'tag.version'),
          options: ['draft', 'approved', 'archived'],
        },
      }),
    );
    expect(valuesTag.options).toContain('archived');
    await callApi('API-TAG-APPLY', {
      body: {
        items: [
          {
            sourceId: scenario.sourceId,
            tagId: scenario.tagId,
            value: 'approved',
          },
        ],
      },
    });

    let source = asObject(
      await callApi('API-SOURCE-GET', { params: { sourceId: scenario.sourceId } }),
    );
    source = asObject(
      await callApi('API-PERMISSION-ENABLE', {
        params: { sourceId: scenario.sourceId },
        body: {
          version: asNumber(source.version, 'source.version'),
          expectedPermissionRevision: asNumber(
            source.permissionRevision,
            'source.permissionRevision',
          ),
        },
      }),
    );
    source = asObject(await callApi('API-SOURCE-GET', { params: { sourceId: scenario.sourceId } }));
    await callApi('API-PERMISSION-DETACH', {
      params: { sourceId: scenario.sourceId },
      body: {
        version: asNumber(source.version, 'source.version'),
        expectedPermissionRevision: asNumber(
          source.permissionRevision,
          'source.permissionRevision',
        ),
      },
    });
    source = asObject(await callApi('API-SOURCE-GET', { params: { sourceId: scenario.sourceId } }));
    await callApi('API-PERMISSION-RESUME', {
      params: { sourceId: scenario.sourceId },
      body: {
        version: asNumber(source.version, 'source.version'),
        expectedPermissionRevision: asNumber(
          source.permissionRevision,
          'source.permissionRevision',
        ),
      },
    });
    source = asObject(await callApi('API-SOURCE-GET', { params: { sourceId: scenario.sourceId } }));
    await callApi('API-PERMISSION-DISABLE', {
      params: { sourceId: scenario.sourceId },
      body: {
        version: asNumber(source.version, 'source.version'),
        expectedPermissionRevision: asNumber(
          source.permissionRevision,
          'source.permissionRevision',
        ),
      },
    });
    source = asObject(await callApi('API-SOURCE-GET', { params: { sourceId: scenario.sourceId } }));

    await callApi('API-ACL-GET', {
      params: { resourceType: 'source', resourceId: scenario.sourceId },
    });
    const overriddenAcl = asObject(
      await callApi('API-ACL-UPDATE', {
        params: { resourceType: 'source', resourceId: scenario.sourceId },
        body: {
          inheritMode: 'override',
          version: asNumber(source.version, 'source.version'),
          entries: [
            {
              principalType: 'member',
              principalId: memberId,
              permission: 'owner',
            },
          ],
        },
      }),
    );
    expect(overriddenAcl.inheritMode).toBe('override');
    source = asObject(await callApi('API-SOURCE-GET', { params: { sourceId: scenario.sourceId } }));
    await callApi('API-ACL-RESUME', {
      params: { resourceType: 'source', resourceId: scenario.sourceId },
      body: { version: asNumber(source.version, 'source.version') },
    });

    await callApi('API-COLLABORATOR-LIST', { params: { spaceId: scenario.spaceId } });
    const collaboratorMemberId = `mem_e2e_collaborator_${suffix}`;
    const collaborator = asObject(
      await callApi('API-COLLABORATOR-CREATE', {
        params: { spaceId: scenario.spaceId },
        body: { memberId: collaboratorMemberId, role: 'read' },
      }),
    );
    await callApi('API-COLLABORATOR-UPDATE', {
      params: { spaceId: scenario.spaceId, memberId: collaboratorMemberId },
      body: {
        version: asNumber(collaborator.version, 'collaborator.version'),
        role: 'write',
      },
    });
    const collaborators = asObject(
      await callApi('API-COLLABORATOR-LIST', { params: { spaceId: scenario.spaceId } }),
    );
    expect(collaborators.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ memberId: collaboratorMemberId })]),
    );
    await callApi('API-COLLABORATOR-DELETE', {
      params: { spaceId: scenario.spaceId, memberId: collaboratorMemberId },
    });

    await callApi('API-RESOURCE-OWNERSHIP-TRANSFER', {
      params: { resourceType: 'directory', resourceId: scenario.directoryId },
      body: {
        version: asNumber(updatedDirectory.version, 'directory.version'),
        targetMemberId: `mem_e2e_directory_owner_${suffix}`,
      },
    });

    const spaceBeforeTransfer = asObject(
      await callApi('API-SPACE-GET', { params: { spaceId: scenario.spaceId } }),
    );
    const transferredSpace = asObject(
      await callApi('API-OWNERSHIP-TRANSFER', {
        params: { spaceId: scenario.spaceId },
        body: {
          version: asNumber(spaceBeforeTransfer.version, 'space.version'),
          targetMemberId: `mem_e2e_space_owner_${suffix}`,
        },
      }),
    );
    expect(transferredSpace.id).toBe(scenario.spaceId);
    expect(transferredSpace.ownershipMemberId).toBe(`mem_e2e_space_owner_${suffix}`);

    const moveFolder = asObject(
      await callApi('API-SPACE-CREATE', {
        body: {
          kind: 'folder',
          name: `E2E move folder ${suffix}`,
          accessMode: 'workspace',
          sourceAclMode: 'inherited',
          sourcePermissionEnabled: true,
        },
      }),
    );
    const currentSpace = asObject(
      await callApi('API-SPACE-GET', { params: { spaceId: scenario.spaceId } }),
    );
    await callApi('API-SPACE-MOVE', {
      params: { spaceId: scenario.spaceId },
      body: {
        targetParentId: asString(moveFolder.id, 'moveFolder.id'),
        version: asNumber(currentSpace.version, 'currentSpace.version'),
      },
    });
    const moveDirectory = asObject(
      await callApi('API-DIRECTORY-CREATE', {
        params: { spaceId: scenario.spaceId },
        body: { name: `E2E move destination ${suffix}` },
      }),
    );
    const currentDirectory = asObject(
      await callApi('API-DIRECTORY-GET', {
        params: { directoryId: scenario.directoryId },
      }),
    );
    await callApi('API-DIRECTORY-MOVE', {
      params: { directoryId: scenario.directoryId },
      body: {
        targetParentId: asString(moveDirectory.id, 'moveDirectory.id'),
        version: asNumber(currentDirectory.version, 'currentDirectory.version'),
      },
    });
    const currentSource = asObject(
      await callApi('API-SOURCE-GET', { params: { sourceId: scenario.sourceId } }),
    );
    await callApi('API-SOURCE-MOVE', {
      params: { sourceId: scenario.sourceId },
      body: {
        targetParentId: null,
        version: asNumber(currentSource.version, 'currentSource.version'),
      },
    });
    const extraSpace = asObject(
      await callApi('API-SPACE-CREATE', {
        body: {
          kind: 'space',
          name: `E2E batch space ${suffix}`,
          accessMode: 'workspace',
          sourceAclMode: 'enforced',
          sourcePermissionEnabled: true,
        },
      }),
    );
    await callApi('API-SPACE-BATCH', {
      body: {
        action: 'delete',
        ids: [asString(extraSpace.id, 'extraSpace.id')],
        versions: {
          [asString(extraSpace.id, 'extraSpace.id')]: asNumber(
            extraSpace.version,
            'extraSpace.version',
          ),
        },
      },
    });
    const extraSource = asObject(
      await callApi('API-SOURCE-CREATE', {
        params: { spaceId: scenario.spaceId },
        body: { kind: 'text', name: `E2E batch source ${suffix}` },
      }),
    );
    await callApi('API-SOURCE-BATCH', {
      body: {
        action: 'move',
        ids: [asString(extraSource.id, 'extraSource.id')],
        targetDirectoryId: asString(moveDirectory.id, 'moveDirectory.id'),
        versions: {
          [asString(extraSource.id, 'extraSource.id')]: asNumber(
            extraSource.version,
            'extraSource.version',
          ),
        },
      },
    });
    await callApi('API-SPACE-REFERENCES', { params: { spaceId: scenario.spaceId } });
    await callApi('API-SPACE-EXPORT', {
      params: { spaceId: scenario.spaceId },
      body: { format: 'zip' },
    });

    const operations = asObject(await callApi('API-OPS-STATUS'));
    expect(operations.vector).toMatchObject({
      backend: 'pgvector',
      healthy: true,
      profiles: [768, 1024, 1536, 3072],
    });
    expect(Object.keys(asObject(operations.queueDepth))).toHaveLength(13);
  });

  it('serves all baseline pages and the console session with accessible shell semantics', async () => {
    const sessionResponse = await fetch(`${baseUrl}/api/console/session`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${authToken}`,
        'x-workspace-id': workspaceId,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(sessionResponse.status).toBe(200);
    const setCookie = sessionResponse.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('kb_console_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    const cookie = setCookie.split(';', 1)[0] ?? '';

    const cookieResponse = await fetch(`${baseUrl}/v1/knowledge/spaces?limit=10`, {
      headers: {
        cookie,
        'x-workspace-id': workspaceId,
      },
    });
    expect(cookieResponse.status).toBe(200);

    const pages: Array<[string, string]> = [
      ['/spaces', '知识空间'],
      ['/spaces/new', '新建知识空间'],
      [`/spaces/${requiredId(scenario.spaceId, 'spaceId')}/overview`, '空间概览'],
      [`/spaces/${requiredId(scenario.spaceId, 'spaceId')}/sources`, '来源'],
      [`/spaces/${requiredId(scenario.spaceId, 'spaceId')}/import`, '导入'],
      [`/spaces/${requiredId(scenario.spaceId, 'spaceId')}/segments`, '分段'],
      [
        `/spaces/${requiredId(scenario.spaceId, 'spaceId')}/segments/${requiredId(scenario.segmentId, 'segmentId')}`,
        '编辑分段',
      ],
      [`/spaces/${requiredId(scenario.spaceId, 'spaceId')}/tags`, '标签'],
      [`/spaces/${requiredId(scenario.spaceId, 'spaceId')}/access`, '访问权限'],
      [`/spaces/${requiredId(scenario.spaceId, 'spaceId')}/jobs`, '任务'],
      ['/system/status', '系统状态'],
    ];
    for (const [path, title] of pages) {
      const response = await fetch(`${baseUrl}${path}`, {
        headers: { cookie },
        signal: AbortSignal.timeout(10_000),
      });
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toContain('text/html');
      const html = await response.text();
      expect(html, path).toContain('<title');
      expect(html, path).toContain(title);
      expect(html, path).toContain('<html lang="zh-CN">');
      expect(html, path).toContain('href="#knowledge-main"');
      expect(html, path).toContain('id="knowledge-main"');
      expect((html.match(/<h1\b/g) ?? []).length, `${path} h1 count`).toBe(1);
      expect(html, path).not.toMatch(/href="\/(?:search|synonyms|connectors|api-keys|models)/);
      expect(html, path).not.toContain('/api/core/dataset');
      expect(html, path).not.toContain('/api/internal/dataset');
      expect(html, path).not.toContain('/proApi/core/dataset');
    }
  });

  it('renders eleven pages at three viewports with accessible shell geometry and axe', async () => {
    const cookie = await consoleCookie();
    const separator = cookie.indexOf('=');
    const cookieName = separator > 0 ? cookie.slice(0, separator) : '';
    const cookieValue = separator > 0 ? cookie.slice(separator + 1) : '';
    if (!cookieName || !cookieValue) throw new Error('console cookie was not initialized');
    const browser = await chromium.launch({ headless: true });
    const viewports = [
      { name: 'mobile', width: 360, height: 800 },
      { name: 'tablet', width: 768, height: 1024 },
      { name: 'desktop', width: 1200, height: 900 },
    ];
    const pages = [
      '/spaces',
      '/spaces/new',
      `/spaces/${requiredId(scenario.spaceId, 'spaceId')}/overview`,
      `/spaces/${requiredId(scenario.spaceId, 'spaceId')}/sources`,
      `/spaces/${requiredId(scenario.spaceId, 'spaceId')}/import`,
      `/spaces/${requiredId(scenario.spaceId, 'spaceId')}/segments`,
      `/spaces/${requiredId(scenario.spaceId, 'spaceId')}/segments/${requiredId(scenario.segmentId, 'segmentId')}`,
      `/spaces/${requiredId(scenario.spaceId, 'spaceId')}/tags`,
      `/spaces/${requiredId(scenario.spaceId, 'spaceId')}/access`,
      `/spaces/${requiredId(scenario.spaceId, 'spaceId')}/jobs`,
      '/system/status',
    ];

    try {
      for (const viewport of viewports) {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
        });
        await context.addCookies([
          {
            name: cookieName,
            value: cookieValue,
            domain: '127.0.0.1',
            path: '/',
            sameSite: 'Strict',
          },
        ]);
        for (const path of pages) {
          const page = await context.newPage();
          const consoleErrors: string[] = [];
          const pageErrors: string[] = [];
          const networkErrors: string[] = [];
          page.on('console', (message) => {
            if (message.type() === 'error') consoleErrors.push(message.text());
          });
          page.on('pageerror', (error) => pageErrors.push(error.message));
          page.on('requestfailed', (request) => {
            networkErrors.push(
              `${request.method()} ${request.url()} ${request.failure()?.errorText ?? 'failed'}`,
            );
          });
          page.on('response', (response) => {
            if (response.status() >= 400) {
              networkErrors.push(
                `${response.request().method()} ${response.url()} ${response.status()}`,
              );
            }
          });

          const response = await page.goto(`${baseUrl}${path}`, {
            waitUntil: 'networkidle',
            timeout: 30_000,
          });
          expect(response?.status(), `${viewport.name} ${path} status`).toBe(200);
          await page.locator('h1').waitFor({ state: 'visible' });
          expect(await page.locator('h1').count(), `${viewport.name} ${path} h1`).toBe(1);
          expect(
            await page.locator('a[href="#knowledge-main"]').count(),
            `${viewport.name} ${path} skip link`,
          ).toBeGreaterThan(0);
          expect(
            await page.locator('#knowledge-main').count(),
            `${viewport.name} ${path} main`,
          ).toBe(1);

          const geometry = await page.evaluate(() => {
            const nav = document
              .querySelector('aside[aria-label="Primary navigation"]')
              ?.getBoundingClientRect();
            const main = document.querySelector('#knowledge-main')?.getBoundingClientRect();
            const heading = document.querySelector('h1')?.getBoundingClientRect();
            const actions = document.querySelector('.page-actions')?.getBoundingClientRect();
            const intersects = (left: DOMRect | undefined, right: DOMRect | undefined): boolean => {
              if (!left || !right) return false;
              return !(
                left.right <= right.left ||
                right.right <= left.left ||
                left.bottom <= right.top ||
                right.bottom <= left.top
              );
            };
            return {
              pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
              navMainOverlap: intersects(nav, main),
              headingActionsOverlap: intersects(heading, actions),
            };
          });
          expect(
            geometry.pageOverflow,
            `${viewport.name} ${path} horizontal overflow`,
          ).toBeLessThanOrEqual(1);
          expect(geometry.navMainOverlap, `${viewport.name} ${path} nav overlap`).toBe(false);
          expect(
            geometry.headingActionsOverlap,
            `${viewport.name} ${path} heading/action overlap`,
          ).toBe(false);

          const accessibility = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
            .analyze();
          const blockingViolations = accessibility.violations.filter(
            (violation) => violation.impact === 'serious' || violation.impact === 'critical',
          );
          expect(blockingViolations, `${viewport.name} ${path} axe serious/critical`).toEqual([]);
          expect(consoleErrors, `${viewport.name} ${path} console errors`).toEqual([]);
          expect(pageErrors, `${viewport.name} ${path} page errors`).toEqual([]);
          expect(networkErrors, `${viewport.name} ${path} network errors`).toEqual([]);
          await page.close();
        }
        await context.close();
      }
    } finally {
      await browser.close();
    }
  });

  it('exercises table controls and preserves form input across one 409 mutation', async () => {
    const cookie = await consoleCookie();
    const separator = cookie.indexOf('=');
    const cookieName = separator > 0 ? cookie.slice(0, separator) : '';
    const cookieValue = separator > 0 ? cookie.slice(separator + 1) : '';
    if (!cookieName || !cookieValue) throw new Error('console cookie was not initialized');
    if (!scenario.spaceId) {
      const createdSpace = asObject(
        await callApi('API-SPACE-CREATE', {
          body: {
            kind: 'space',
            name: `E2E table space ${suffix}`,
            description: 'Focused table control fixture',
            iconKey: 'book-open',
            accessMode: 'workspace',
            sourceAclMode: 'enforced',
            sourcePermissionEnabled: true,
          },
        }),
      );
      scenario.spaceId = asString(createdSpace.id, 'table.spaceId');
    }
    const spaceId = requiredId(scenario.spaceId, 'spaceId');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 360, height: 800 } });
    await context.addCookies([
      {
        name: cookieName,
        value: cookieValue,
        domain: '127.0.0.1',
        path: '/',
        sameSite: 'Strict',
      },
    ]);

    try {
      const page = await context.newPage();
      await page.goto(`${baseUrl}/spaces`, { waitUntil: 'networkidle' });
      const tableCaption = page.locator('table caption');
      await tableCaption.waitFor();
      expect(await tableCaption.textContent()).toBe('空间清单');
      expect(await page.locator('th[scope="col"]').count()).toBeGreaterThan(0);

      await page.getByRole('button', { name: '列' }).click();
      const statusColumnToggle = page.getByRole('checkbox', { name: '状态', exact: true });
      await statusColumnToggle.uncheck({ force: true });
      expect(await statusColumnToggle.isChecked()).toBe(false);
      await page.locator('thead th').filter({ hasText: '状态' }).waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: '紧凑' }).click();
      expect(await page.getByRole('button', { name: '紧凑' }).getAttribute('aria-pressed')).toBe(
        'true',
      );
      const tableGeometry = await page.evaluate(() => {
        const container = document.querySelector('.table-scroll');
        if (!container) return null;
        return {
          containerWidth: container.clientWidth,
          tableWidth: container.scrollWidth,
          pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
        };
      });
      expect(tableGeometry).not.toBeNull();
      expect(tableGeometry!.containerWidth).toBeLessThanOrEqual(360);
      expect(tableGeometry!.tableWidth).toBeGreaterThan(tableGeometry!.containerWidth);
      expect(tableGeometry!.pageOverflow).toBeLessThanOrEqual(1);

      let patchCount = 0;
      let patchServed = false;
      const detailPath = `/v1/knowledge/spaces/${spaceId}`;
      await page.route(`**${detailPath}`, async (route) => {
        if (route.request().method() !== 'PATCH') {
          await route.continue();
          return;
        }
        patchCount += 1;
        if (!patchServed) {
          patchServed = true;
          await new Promise((resolveWait) => setTimeout(resolveWait, 250));
          await route.fulfill({
            status: 409,
            contentType: 'application/json',
            body: JSON.stringify({
              success: false,
              error: {
                code: 'KNOWLEDGE_VALIDATION_FAILED',
                message: 'backend text must not become local copy',
                retryable: false,
                details: { field: 'name' },
              },
              traceId: 'trace-ui-conflict',
              requestId: 'request-ui-conflict',
            }),
          });
          return;
        }
        await route.continue();
      });

      await page.goto(`${baseUrl}/spaces/${spaceId}/overview`, { waitUntil: 'networkidle' });
      const nameInput = page.getByLabel('名称');
      await nameInput.fill('Preserved draft');
      const form = page.locator('form.form-band');
      await form.evaluate((element) => {
        const formElement = element as HTMLFormElement;
        formElement.requestSubmit();
        formElement.requestSubmit();
      });
      await page.locator('.problem-notice').waitFor();
      expect(patchCount).toBe(1);
      expect(await nameInput.inputValue()).toBe('Preserved draft');
      expect(await page.getByText('KNOWLEDGE_VALIDATION_FAILED').count()).toBeGreaterThan(0);
      expect(await page.getByText('请求校验失败').count()).toBeGreaterThan(0);
      expect(await page.getByText('不可重试').count()).toBeGreaterThan(0);
      expect(await page.getByText('追踪 trace-ui-conflict').count()).toBeGreaterThan(0);
      expect(await page.getByText('请求 request-ui-conflict').count()).toBeGreaterThan(0);
      expect(await page.locator('body').textContent()).not.toContain(
        'backend text must not become local copy',
      );

      await page.unroute(`**${detailPath}`);
      const requestCounts = new Map<string, number>();
      page.on('request', (request) => {
        if (request.method() !== 'GET') return;
        const path = new URL(request.url()).pathname;
        requestCounts.set(path, (requestCounts.get(path) ?? 0) + 1);
      });
      await nameInput.fill('Updated evidence name');
      await page.getByRole('button', { name: '保存元数据' }).click();
      await page.waitForFunction(
        () =>
          (document.querySelector('input[name="name"]') as HTMLInputElement | null)?.value === '',
      );
      await page.waitForLoadState('networkidle');
      expect(requestCounts.get(detailPath) ?? 0).toBeGreaterThanOrEqual(1);
      expect(requestCounts.get(`/v1/knowledge/spaces/${spaceId}/directories`) ?? 0).toBe(0);
      expect(requestCounts.get(`/v1/knowledge/spaces/${spaceId}/sources`) ?? 0).toBe(0);
      await page.close();
    } finally {
      await context.close();
      await browser.close();
    }
  });

  it('replays a batch idempotency key without a second write and rejects changed bodies', async () => {
    const target = asObject(
      await callApi('API-SPACE-CREATE', {
        body: {
          kind: 'folder',
          name: `Batch idempotency target ${suffix}`,
          accessMode: 'workspace',
          sourceAclMode: 'inherited',
          sourcePermissionEnabled: true,
        },
      }),
    );
    const targetId = asString(target.id, 'targetId');
    const first = asObject(
      await callApi('API-SPACE-CREATE', {
        body: {
          kind: 'space',
          name: `Batch idempotency A ${suffix}`,
          accessMode: 'workspace',
          sourceAclMode: 'enforced',
          sourcePermissionEnabled: true,
        },
      }),
    );
    const second = asObject(
      await callApi('API-SPACE-CREATE', {
        body: {
          kind: 'space',
          name: `Batch idempotency B ${suffix}`,
          accessMode: 'workspace',
          sourceAclMode: 'enforced',
          sourcePermissionEnabled: true,
        },
      }),
    );
    const firstId = asString(first.id, 'firstId');
    const secondId = asString(second.id, 'secondId');
    const operation = runtimeById.get('API-SPACE-BATCH');
    if (!operation) throw new Error('API-SPACE-BATCH is not in runtime');
    const batchPath = `${baseUrl}${operation.path}`;
    const requestBatch = async (idempotencyKey: string, body: unknown) => {
      requestSequence += 1;
      const response = await fetch(batchPath, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${authToken}`,
          'x-workspace-id': workspaceId,
          'x-request-id': `req_batch_idem_${suffix}_${requestSequence}`,
          traceparent: `00-${suffix.padEnd(32, '0').slice(0, 32)}-${String(requestSequence).padStart(16, '0')}-01`,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(body),
      });
      return {
        status: response.status,
        payload: (await response.json()) as Record<string, unknown>,
      };
    };
    const firstBody = {
      action: 'move',
      ids: [firstId, secondId],
      targetParentId: targetId,
      versions: {
        [firstId]: Number(first.version),
        [secondId]: Number(second.version),
      },
    };
    const key = `batch-idempotency-${suffix}`;
    const original = await requestBatch(key, firstBody);
    const replay = await requestBatch(key, firstBody);
    expect(original.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.payload.data).toEqual(original.payload.data);
    const movedFirst = asObject(await callApi('API-SPACE-GET', { params: { spaceId: firstId } }));
    const movedSecond = asObject(await callApi('API-SPACE-GET', { params: { spaceId: secondId } }));
    expect(movedFirst).toMatchObject({
      parentSpaceId: targetId,
      version: Number(first.version) + 1,
    });
    expect(movedSecond).toMatchObject({
      parentSpaceId: targetId,
      version: Number(second.version) + 1,
    });

    const changedBody = await requestBatch(key, {
      ...firstBody,
      targetParentId: null,
      versions: {
        [firstId]: Number(movedFirst.version),
        [secondId]: Number(movedSecond.version),
      },
    });
    expect(changedBody.status).toBe(409);
    expect(changedBody.payload).toMatchObject({
      success: false,
      error: { code: 'KNOWLEDGE_CONFLICT' },
    });

    const newKey = await requestBatch(`batch-idempotency-new-${suffix}`, {
      action: 'move',
      ids: [firstId, secondId],
      targetParentId: null,
      versions: {
        [firstId]: Number(movedFirst.version),
        [secondId]: Number(movedSecond.version),
      },
    });
    expect(newKey.status).toBe(200);
    const restoredFirst = asObject(
      await callApi('API-SPACE-GET', { params: { spaceId: firstId } }),
    );
    const restoredSecond = asObject(
      await callApi('API-SPACE-GET', { params: { spaceId: secondId } }),
    );
    expect(restoredFirst).toMatchObject({
      parentSpaceId: null,
      version: Number(first.version) + 2,
    });
    expect(restoredSecond).toMatchObject({
      parentSpaceId: null,
      version: Number(second.version) + 2,
    });
  });

  it('renders S3 partial, conflict, forbidden, reference and export states', async () => {
    const cookie = await consoleCookie();
    const separator = cookie.indexOf('=');
    const cookieName = separator > 0 ? cookie.slice(0, separator) : '';
    const cookieValue = separator > 0 ? cookie.slice(separator + 1) : '';
    if (!cookieName || !cookieValue) throw new Error('console cookie was not initialized');
    const spaceId = requiredId(scenario.spaceId, 'spaceId');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    await context.addCookies([
      {
        name: cookieName,
        value: cookieValue,
        domain: '127.0.0.1',
        path: '/',
        sameSite: 'Strict',
      },
    ]);

    try {
      const page = await context.newPage();
      await page.route('**/v1/knowledge/spaces/batch-actions', (route) =>
        route.fulfill({
          status: 207,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              code: 'KNOWLEDGE_PARTIAL_SUCCESS',
              requested: 2,
              succeeded: 1,
              failed: 1,
              items: [
                { id: spaceId, success: true },
                { id: '65f1e5b2a1c9d4b7e8f09999', success: false, code: 'KNOWLEDGE_CONFLICT' },
              ],
            },
            traceId: 'trace-ui-partial',
            requestId: 'request-ui-partial',
          }),
        }),
      );
      await page.goto(`${baseUrl}/spaces`, { waitUntil: 'networkidle' });
      await page.locator('table caption').waitFor();
      await page
        .getByRole('checkbox', { name: /选择空间/ })
        .first()
        .check();
      await page.getByRole('button', { name: '批量移动' }).click();
      await page.getByText('部分完成：成功 1 项，失败 1 项').waitFor();
      await page.unroute('**/v1/knowledge/spaces/batch-actions');

      const moveKeys: string[] = [];
      let moveCount = 0;
      await page.route('**/v1/knowledge/spaces/*/move', async (route) => {
        moveCount += 1;
        moveKeys.push(route.request().headers()['idempotency-key'] ?? '');
        const forbidden = moveCount > 1;
        await route.fulfill({
          status: forbidden ? 403 : 409,
          contentType: 'application/json',
          body: JSON.stringify({
            success: false,
            error: {
              code: forbidden ? 'KNOWLEDGE_FORBIDDEN' : 'KNOWLEDGE_CONFLICT',
              message: 'localized fixture',
              retryable: false,
              details: {},
            },
            traceId: `trace-ui-move-${moveCount}`,
            requestId: `request-ui-move-${moveCount}`,
          }),
        });
      });
      const moveTarget = page.getByLabel('移动目标').first();
      const moveOptions = await moveTarget
        .locator('option')
        .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
      await moveTarget.selectOption(moveOptions[1] ?? '');
      await page.getByRole('button', { name: '移动', exact: true }).first().click();
      await page.locator('.move-control .problem-notice').getByText('KNOWLEDGE_CONFLICT').waitFor();
      await page.getByRole('button', { name: '移动', exact: true }).first().click();
      await page
        .locator('.move-control .problem-notice')
        .getByText('KNOWLEDGE_FORBIDDEN')
        .waitFor();
      await moveTarget.selectOption(moveOptions[0] ?? '');
      await page.getByRole('button', { name: '移动', exact: true }).first().click();
      expect(new Set(moveKeys).size).toBe(3);
      await page.unroute('**/v1/knowledge/spaces/*/move');

      await page.route(`**/v1/knowledge/spaces/${spaceId}/references`, (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              referenceRevision: 7,
              count: 1,
              items: [
                {
                  referrerType: 'workflow',
                  referrerId: 'workflow-ui',
                  referrerVersion: 'v3',
                  referrerName: 'UI workflow',
                  status: 'active',
                  lastSeenAt: '2026-10-26T10:00:00+08:00',
                },
              ],
            },
            traceId: 'trace-ui-reference',
            requestId: 'request-ui-reference',
          }),
        }),
      );
      await page.route(`**/v1/knowledge/spaces/${spaceId}/exports`, (route) =>
        route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              jobId: '65f1e5b2a1c9d4b7e8f07777',
              workspaceId,
              knowledgeSpaceId: spaceId,
              kind: 'export',
              status: 'queued',
              priority: 0,
              attempts: 0,
              maxAttempts: 3,
              progress: { stage: 'queued', completed: 0, total: 1, percent: 0 },
              createdAt: '2026-10-26T10:00:00+08:00',
              updatedAt: '2026-10-26T10:00:00+08:00',
            },
            traceId: 'trace-ui-export',
            requestId: 'request-ui-export',
          }),
        }),
      );
      await page.route('**/v1/knowledge/jobs/65f1e5b2a1c9d4b7e8f07777', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              jobId: '65f1e5b2a1c9d4b7e8f07777',
              workspaceId,
              knowledgeSpaceId: spaceId,
              kind: 'export',
              status: 'failed',
              priority: 0,
              attempts: 1,
              maxAttempts: 3,
              progress: { stage: 'running', completed: 0, total: 1, percent: 0 },
              error: { code: 'KNOWLEDGE_JOB_FAILED', retryable: false, details: {} },
              createdAt: '2026-10-26T10:00:00+08:00',
              updatedAt: '2026-10-26T10:00:01+08:00',
            },
            traceId: 'trace-ui-export-job',
            requestId: 'request-ui-export-job',
          }),
        }),
      );
      await page.goto(`${baseUrl}/spaces/${spaceId}/overview`, { waitUntil: 'networkidle' });
      await page.getByText('存在活动引用，当前空间不能删除。').waitFor();
      await page.getByRole('button', { name: '导出空间 ZIP' }).click();
      await page.getByText('失败', { exact: true }).waitFor({ timeout: 10_000 });
    } finally {
      await browser.close();
    }
  });

  it('renders S3 states with export lifecycle and screenshots at three viewports', async () => {
    const cookie = await consoleCookie();
    const separator = cookie.indexOf('=');
    const cookieName = separator > 0 ? cookie.slice(0, separator) : '';
    const cookieValue = separator > 0 ? cookie.slice(separator + 1) : '';
    if (!cookieName || !cookieValue) throw new Error('console cookie was not initialized');
    const spaceId = requiredId(scenario.spaceId, 'spaceId');
    const exportBlobId = '65f1e5b2a1c9d4b7e8f08888';
    const firstJobId = '65f1e5b2a1c9d4b7e8f07777';
    const secondJobId = '65f1e5b2a1c9d4b7e8f06666';
    const screenshotDirectory = join(repositoryRoot, 'docs', 'acceptance', 's3-ui');
    mkdirSync(screenshotDirectory, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    try {
      for (const viewport of [
        { name: 'mobile', width: 360, height: 900 },
        { name: 'tablet', width: 768, height: 900 },
        { name: 'desktop', width: 1200, height: 900 },
      ]) {
        const viewportContext = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
        });
        await viewportContext.addCookies([
          {
            name: cookieName,
            value: cookieValue,
            domain: '127.0.0.1',
            path: '/',
            sameSite: 'Strict',
          },
        ]);
        try {
          const page = await viewportContext.newPage();
          await page.route('**/v1/knowledge/spaces/batch-actions', (route) =>
            route.fulfill({
              status: 207,
              contentType: 'application/json',
              body: JSON.stringify({
                success: true,
                data: {
                  code: 'KNOWLEDGE_PARTIAL_SUCCESS',
                  requested: 2,
                  succeeded: 1,
                  failed: 1,
                  items: [
                    { id: spaceId, success: true },
                    {
                      id: '65f1e5b2a1c9d4b7e8f09999',
                      success: false,
                      code: 'KNOWLEDGE_CONFLICT',
                    },
                  ],
                },
                traceId: `trace-ui-partial-${viewport.name}`,
                requestId: `request-ui-partial-${viewport.name}`,
              }),
            }),
          );
          await page.goto(`${baseUrl}/spaces`, { waitUntil: 'networkidle' });
          await page.locator('table caption').waitFor();
          await page
            .getByRole('checkbox', { name: /选择空间/ })
            .first()
            .check();
          await page.getByRole('button', { name: '批量移动' }).click();
          await page.getByText('部分完成：成功 1 项，失败 1 项').waitFor();
          await page.unroute('**/v1/knowledge/spaces/batch-actions');

          const moveKeys: string[] = [];
          let moveCount = 0;
          await page.route('**/v1/knowledge/spaces/*/move', async (route) => {
            moveCount += 1;
            moveKeys.push(route.request().headers()['idempotency-key'] ?? '');
            const forbidden = moveCount > 1;
            await route.fulfill({
              status: forbidden ? 403 : 409,
              contentType: 'application/json',
              body: JSON.stringify({
                success: false,
                error: {
                  code: forbidden ? 'KNOWLEDGE_FORBIDDEN' : 'KNOWLEDGE_CONFLICT',
                  message: 'localized fixture',
                  retryable: false,
                  details: {},
                },
                traceId: `trace-ui-move-${viewport.name}-${moveCount}`,
                requestId: `request-ui-move-${viewport.name}-${moveCount}`,
              }),
            });
          });
          const moveTarget = page.getByLabel('移动目标').first();
          const moveOptions = await moveTarget
            .locator('option')
            .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
          await moveTarget.selectOption(moveOptions[1] ?? '');
          await page.getByRole('button', { name: '移动', exact: true }).first().click();
          await page
            .locator('.move-control .problem-notice')
            .getByText('KNOWLEDGE_CONFLICT')
            .waitFor();
          await page.getByRole('button', { name: '移动', exact: true }).first().click();
          await page
            .locator('.move-control .problem-notice')
            .getByText('KNOWLEDGE_FORBIDDEN')
            .waitFor();
          await moveTarget.selectOption(moveOptions[0] ?? '');
          await page.getByRole('button', { name: '移动', exact: true }).first().click();
          expect(new Set(moveKeys).size).toBe(3);
          await page.unroute('**/v1/knowledge/spaces/*/move');

          await page.route(`**/v1/knowledge/spaces/${spaceId}/references`, (route) =>
            route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                success: true,
                data: {
                  referenceRevision: 7,
                  count: 1,
                  items: [
                    {
                      referrerType: 'workflow',
                      referrerId: 'workflow-ui',
                      referrerVersion: 'v3',
                      referrerName: 'UI workflow',
                      status: 'active',
                      lastSeenAt: '2026-10-26T10:00:00+08:00',
                    },
                  ],
                },
                traceId: `trace-ui-reference-${viewport.name}`,
                requestId: `request-ui-reference-${viewport.name}`,
              }),
            }),
          );
          let exportPosts = 0;
          await page.route(`**/v1/knowledge/spaces/${spaceId}/exports`, (route) => {
            exportPosts += 1;
            const jobId = exportPosts === 1 ? firstJobId : secondJobId;
            return route.fulfill({
              status: 202,
              contentType: 'application/json',
              body: JSON.stringify({
                success: true,
                data: {
                  jobId,
                  workspaceId,
                  knowledgeSpaceId: spaceId,
                  kind: 'export',
                  status: 'queued',
                  priority: 0,
                  attempts: 0,
                  maxAttempts: 3,
                  progress: { stage: 'queued', completed: 0, total: 1, percent: 0 },
                  createdAt: '2026-10-26T10:00:00+08:00',
                  updatedAt: '2026-10-26T10:00:00+08:00',
                },
                traceId: `trace-ui-export-${viewport.name}-${exportPosts}`,
                requestId: `request-ui-export-${viewport.name}-${exportPosts}`,
              }),
            });
          });
          let releaseRunning: (() => void) | undefined;
          const runningGate = new Promise<void>((resolveRunning) => {
            releaseRunning = resolveRunning;
          });
          let firstJobGets = 0;
          await page.route(`**/v1/knowledge/jobs/${firstJobId}`, async (route) => {
            firstJobGets += 1;
            if (firstJobGets === 1) {
              await runningGate;
            }
            const succeeded = firstJobGets > 1;
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                success: true,
                data: {
                  jobId: firstJobId,
                  workspaceId,
                  knowledgeSpaceId: spaceId,
                  kind: 'export',
                  status: succeeded ? 'succeeded' : 'running',
                  priority: 0,
                  attempts: 1,
                  maxAttempts: 3,
                  progress: {
                    stage: succeeded ? 'succeeded' : 'running',
                    completed: succeeded ? 1 : 0,
                    total: 1,
                    percent: succeeded ? 100 : 50,
                  },
                  result: succeeded
                    ? {
                        objectBlobRefId: exportBlobId,
                        sourceCount: 1,
                        expiresAt: '2026-10-27T10:00:00+08:00',
                      }
                    : null,
                  error: null,
                  createdAt: '2026-10-26T10:00:00+08:00',
                  updatedAt: succeeded ? '2026-10-26T10:00:02+08:00' : '2026-10-26T10:00:01+08:00',
                },
                traceId: `trace-ui-export-job-${viewport.name}-${firstJobGets}`,
                requestId: `request-ui-export-job-${viewport.name}-${firstJobGets}`,
              }),
            });
          });
          await page.route(`**/v1/knowledge/jobs/${secondJobId}`, (route) =>
            route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                success: true,
                data: {
                  jobId: secondJobId,
                  workspaceId,
                  knowledgeSpaceId: spaceId,
                  kind: 'export',
                  status: 'failed',
                  priority: 0,
                  attempts: 1,
                  maxAttempts: 3,
                  progress: { stage: 'running', completed: 0, total: 1, percent: 0 },
                  error: { code: 'KNOWLEDGE_JOB_FAILED', retryable: false, details: {} },
                  createdAt: '2026-10-26T10:00:00+08:00',
                  updatedAt: '2026-10-26T10:00:01+08:00',
                },
                traceId: `trace-ui-export-failed-${viewport.name}`,
                requestId: `request-ui-export-failed-${viewport.name}`,
              }),
            }),
          );
          await page.route(`**/v1/knowledge/files/${exportBlobId}/download`, (route) =>
            route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                success: true,
                data: {
                  ticketId: 'export-ticket',
                  url: `${baseUrl}/downloads/export.zip?ticket=export-ticket`,
                  disposition: 'attachment',
                  expiresAt: '2026-10-26T10:05:00+08:00',
                },
                traceId: `trace-ui-export-ticket-${viewport.name}`,
                requestId: `request-ui-export-ticket-${viewport.name}`,
              }),
            }),
          );

          await page.goto(`${baseUrl}/spaces/${spaceId}/overview`, {
            waitUntil: 'networkidle',
          });
          await page.getByText('存在活动引用，当前空间不能删除。').waitFor();
          await page.getByRole('button', { name: '导出空间 ZIP' }).click();
          await page.getByText('排队中', { exact: true }).waitFor();
          if (!releaseRunning) throw new Error('running gate was not initialized');
          releaseRunning();
          await page.getByText('运行中', { exact: true }).waitFor();
          await page.getByText('已成功', { exact: true }).waitFor({ timeout: 10_000 });
          await page.getByRole('link', { name: '下载导出' }).waitFor();

          const accessibility = await new AxeBuilder({ page }).analyze();
          const blockingViolations = accessibility.violations.filter(
            (violation) => violation.impact === 'serious' || violation.impact === 'critical',
          );
          expect(blockingViolations, `${viewport.name} S3 overview axe serious/critical`).toEqual(
            [],
          );
          const hasNoHorizontalOverflow = await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth + 1,
          );
          expect(hasNoHorizontalOverflow, `${viewport.name} horizontal overflow`).toBe(true);
          await page.evaluate(() => {
            window.scrollTo(0, 0);
            if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          });
          await page.waitForTimeout(100);
          const screenshotPath = join(screenshotDirectory, `s3-overview-${viewport.width}.png`);
          if (!existsSync(screenshotPath)) {
            await page.screenshot({ path: screenshotPath, fullPage: true });
          }

          await page.getByRole('button', { name: '导出空间 ZIP' }).click();
          await page.getByText('失败', { exact: true }).waitFor({ timeout: 10_000 });
        } finally {
          await viewportContext.close();
        }
      }
    } finally {
      await browser.close();
    }
  });

  it('handles 204 deletes for an isolated tag and collaborator through the UI', async () => {
    const cookie = await consoleCookie();
    const separator = cookie.indexOf('=');
    const cookieName = separator > 0 ? cookie.slice(0, separator) : '';
    const cookieValue = separator > 0 ? cookie.slice(separator + 1) : '';
    if (!cookieName || !cookieValue) throw new Error('console cookie was not initialized');
    const spaceId = requiredId(scenario.spaceId, 'spaceId');
    const tagLabel = `UI delete tag ${suffix}`;
    const createdTag = asObject(
      await callApi('API-TAG-CREATE', {
        params: { spaceId },
        body: {
          key: `ui_delete_${suffix.slice(0, 8)}`,
          label: tagLabel,
          tagType: 'string',
          required: false,
          options: ['draft', 'approved'],
        },
      }),
    );
    const tagId = asString(createdTag.id, 'tagId');
    const collaboratorMemberId = `mem_e2e_delete_${suffix}`;
    await callApi('API-COLLABORATOR-CREATE', {
      params: { spaceId },
      body: { memberId: collaboratorMemberId, role: 'read' },
    });

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    await context.addCookies([
      {
        name: cookieName,
        value: cookieValue,
        domain: '127.0.0.1',
        path: '/',
        sameSite: 'Strict',
      },
    ]);

    try {
      const page = await context.newPage();
      const tagListPath = `/v1/knowledge/spaces/${spaceId}/tags`;
      const collaboratorListPath = `/v1/knowledge/spaces/${spaceId}/collaborators`;
      const spaceAclPath = `/v1/knowledge/resources/space/${spaceId}/acl`;
      let tagGets = 0;
      let collaboratorGets = 0;
      let spaceAclGets = 0;
      page.on('request', (request) => {
        if (request.method() !== 'GET') return;
        const path = new URL(request.url()).pathname;
        if (path === tagListPath) tagGets += 1;
        if (path === collaboratorListPath) collaboratorGets += 1;
        if (path === spaceAclPath) spaceAclGets += 1;
      });

      await page.goto(`${baseUrl}/spaces/${spaceId}/tags`, { waitUntil: 'networkidle' });
      const tagRow = page.locator('tbody tr').filter({ hasText: tagLabel });
      await tagRow.waitFor();
      const tagGetsBeforeDelete = tagGets;
      page.once('dialog', (dialog) => dialog.accept());
      const tagDelete = page.waitForResponse(
        (response) =>
          response.request().method() === 'DELETE' &&
          new URL(response.url()).pathname === `/v1/knowledge/tags/${tagId}`,
      );
      await tagRow.getByRole('button', { name: '删除' }).click();
      expect((await tagDelete).status()).toBe(204);
      await tagRow.waitFor({ state: 'detached' });
      await page.waitForLoadState('networkidle');
      expect(tagGets).toBeGreaterThan(tagGetsBeforeDelete);
      expect(await page.locator('.problem-notice').count()).toBe(0);

      await page.goto(`${baseUrl}/spaces/${spaceId}/access`, { waitUntil: 'networkidle' });
      const collaboratorSection = page.locator('section').filter({
        has: page.getByRole('heading', { level: 2, name: '协作者', exact: true }),
      });
      const collaboratorRow = collaboratorSection
        .locator('tbody tr')
        .filter({ hasText: collaboratorMemberId });
      await collaboratorRow.waitFor();
      const collaboratorGetsBeforeDelete = collaboratorGets;
      const spaceAclGetsBeforeDelete = spaceAclGets;
      page.once('dialog', (dialog) => dialog.accept());
      const collaboratorDelete = page.waitForResponse(
        (response) =>
          response.request().method() === 'DELETE' &&
          new URL(response.url()).pathname ===
            `/v1/knowledge/spaces/${spaceId}/collaborators/${collaboratorMemberId}`,
      );
      await collaboratorRow.getByRole('button', { name: '移除' }).click();
      expect((await collaboratorDelete).status()).toBe(204);
      await collaboratorRow.waitFor({ state: 'detached' });
      await page.waitForLoadState('networkidle');
      expect(collaboratorGets).toBeGreaterThan(collaboratorGetsBeforeDelete);
      expect(spaceAclGets).toBeGreaterThan(spaceAclGetsBeforeDelete);
      expect(await page.locator('.problem-notice').count()).toBe(0);
      await page.close();
    } finally {
      await context.close();
      await browser.close();
    }
  });

  it('renders all eleven routes in zh-CN and en with exact titles and form labels', async () => {
    const spaceId = requiredId(scenario.spaceId, 'spaceId');
    const sourceId = requiredId(scenario.sourceId, 'sourceId');
    const segmentId = requiredId(scenario.segmentId, 'segmentId');
    const space = asObject(await callApi('API-SPACE-GET', { params: { spaceId } }));
    const spaceName = asString(space.name, 'space.name');
    const routes = [
      {
        path: '/spaces',
        zh: { title: '知识空间', h1: '知识空间' },
        en: { title: 'Knowledge spaces', h1: 'Spaces' },
      },
      {
        path: '/spaces/new',
        zh: { title: '新建知识空间', h1: '新建空间' },
        en: { title: 'New knowledge space', h1: 'New space' },
        enForm: {
          labels: ['Name', 'Description'],
          button: 'Create space',
        },
      },
      {
        path: `/spaces/${spaceId}/overview`,
        zh: { title: `${spaceName} · 空间概览`, h1: spaceName },
        en: { title: `${spaceName} · Space overview`, h1: spaceName },
      },
      {
        path: `/spaces/${spaceId}/sources`,
        zh: { title: `${spaceName} · 来源`, h1: '来源' },
        en: { title: `${spaceName} · Sources`, h1: 'Sources' },
        enForm: {
          labels: ['Name', 'Kind'],
          button: 'Create Source',
        },
      },
      {
        path: `/spaces/${spaceId}/import`,
        zh: { title: `${spaceName} · 导入`, h1: '导入知识来源' },
        en: { title: `${spaceName} · Import`, h1: 'Import knowledge sources' },
      },
      {
        path: `/spaces/${spaceId}/segments?sourceId=${sourceId}`,
        zh: { title: `${spaceName} · 分段`, h1: '分段' },
        en: { title: `${spaceName} · Segments`, h1: 'Segments' },
        enForm: {
          labels: ['Question', 'Answer'],
          button: 'Create Segment',
        },
      },
      {
        path: `/spaces/${spaceId}/segments/${segmentId}`,
        zh: { title: '编辑分段', h1: '编辑分段' },
        en: { title: 'Edit segment', h1: 'Edit segment' },
      },
      {
        path: `/spaces/${spaceId}/tags`,
        zh: { title: `${spaceName} · 标签`, h1: '标签' },
        en: { title: `${spaceName} · Tags`, h1: 'Tags' },
        enForm: {
          labels: ['Key', 'Label', 'Value type'],
          button: 'Create Tag',
        },
      },
      {
        path: `/spaces/${spaceId}/access`,
        zh: { title: `${spaceName} · 访问权限`, h1: '访问权限' },
        en: { title: `${spaceName} · Access`, h1: 'Access' },
        enForm: {
          labels: ['Member ID', 'Role'],
          button: 'Add collaborator',
        },
      },
      {
        path: `/spaces/${spaceId}/jobs`,
        zh: { title: `${spaceName} · 任务`, h1: '任务' },
        en: { title: `${spaceName} · Jobs`, h1: 'Jobs' },
      },
      {
        path: '/system/status',
        zh: { title: '系统状态', h1: '系统状态' },
        en: { title: 'System status', h1: 'System status' },
      },
    ] as const;
    const cookie = await consoleCookie();
    const separator = cookie.indexOf('=');
    const cookieName = separator > 0 ? cookie.slice(0, separator) : '';
    const cookieValue = separator > 0 ? cookie.slice(separator + 1) : '';
    if (!cookieName || !cookieValue) throw new Error('console cookie was not initialized');
    const browser = await chromium.launch({ headless: true });

    try {
      for (const locale of ['zh-CN', 'en'] as const) {
        const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
        await context.addInitScript((value) => {
          window.localStorage.setItem('kb.locale', value);
        }, locale);
        await context.addCookies([
          {
            name: cookieName,
            value: cookieValue,
            domain: '127.0.0.1',
            path: '/',
            sameSite: 'Strict',
          },
        ]);
        try {
          for (const route of routes) {
            const page = await context.newPage();
            const response = await page.goto(`${baseUrl}${route.path}`, {
              waitUntil: 'networkidle',
            });
            expect(response?.status(), `${locale} ${route.path} status`).toBe(200);
            await page.waitForFunction(
              (expectedLocale) => document.documentElement.lang === expectedLocale,
              locale,
            );
            const expected = route[locale === 'zh-CN' ? 'zh' : 'en'];
            expect(await page.title(), `${locale} ${route.path} title`).toBe(expected.title);
            const headings = page.getByRole('heading', { level: 1 });
            expect(await headings.count(), `${locale} ${route.path} H1 count`).toBe(1);
            expect(await headings.textContent(), `${locale} ${route.path} H1`).toBe(expected.h1);
            expect(
              await page
                .getByRole('link', {
                  name: locale === 'zh-CN' ? '跳到主要内容' : 'Skip to content',
                })
                .count(),
            ).toBe(1);
            const primaryNavigation = page.locator('aside.console-rail nav.rail-nav');
            expect(await primaryNavigation.count()).toBe(1);
            const hasSpaceNavigation = route.path.startsWith(`/spaces/${spaceId}/`);
            const expectedNavigation =
              locale === 'zh-CN'
                ? [
                    '知识空间',
                    '系统状态',
                    '连接器',
                    ...(hasSpaceNavigation
                      ? ['概览', '来源', '导入', '分段', '标签', '访问权限', '任务', '搜索', '图片']
                      : []),
                  ]
                : [
                    'Spaces',
                    'System status',
                    'Connectors',
                    ...(hasSpaceNavigation
                      ? [
                          'Overview',
                          'Sources',
                          'Import',
                          'Segments',
                          'Tags',
                          'Access',
                          'Jobs',
                          'Search',
                          'Images',
                        ]
                      : []),
                  ];
            const navigationLabels = await primaryNavigation.locator('a').evaluateAll((links) =>
              links.map((link) => {
                const labels = Array.from(link.querySelectorAll('span'))
                  .map((span) => span.textContent?.trim() ?? '')
                  .filter(Boolean);
                return labels.at(-1) ?? link.textContent?.trim() ?? '';
              }),
            );
            expect(navigationLabels.sort(), `${locale} ${route.path} navigation`).toEqual(
              expectedNavigation.sort(),
            );
            expect(await page.locator('body').textContent()).not.toMatch(rawMessageKeyPattern);
            if (locale === 'en' && 'enForm' in route && route.enForm) {
              const form = page.locator('form.form-band').first();
              await form.waitFor();
              for (const label of route.enForm.labels) {
                expect(
                  await form.getByLabel(label, { exact: true }).count(),
                  `${route.path} label ${label}`,
                ).toBe(1);
              }
              expect(
                await form.getByRole('button', { name: route.enForm.button }).count(),
                `${route.path} button ${route.enForm.button}`,
              ).toBe(1);
            }
            await page.close();
          }
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  });

  it('renders the English empty state and a safe localized 409 Problem', async () => {
    const cookie = await consoleCookie();
    const separator = cookie.indexOf('=');
    const cookieName = separator > 0 ? cookie.slice(0, separator) : '';
    const cookieValue = separator > 0 ? cookie.slice(separator + 1) : '';
    if (!cookieName || !cookieValue) throw new Error('console cookie was not initialized');
    const spaceId = requiredId(scenario.spaceId, 'spaceId');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    await context.addInitScript(() => {
      window.localStorage.setItem('kb.locale', 'en');
    });
    await context.addCookies([
      {
        name: cookieName,
        value: cookieValue,
        domain: '127.0.0.1',
        path: '/',
        sameSite: 'Strict',
      },
    ]);

    try {
      const page = await context.newPage();
      await page.route('**/v1/knowledge/spaces**', async (route) => {
        const url = new URL(route.request().url());
        if (
          route.request().method() === 'GET' &&
          url.pathname === '/v1/knowledge/spaces' &&
          url.searchParams.get('limit') === '200'
        ) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              success: true,
              data: {
                items: [],
                pageInfo: { nextCursor: null, hasMore: false },
              },
              traceId: 'trace-empty',
              requestId: 'request-empty',
            }),
          });
          return;
        }
        await route.continue();
      });
      await page.goto(`${baseUrl}/spaces`, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => document.documentElement.lang === 'en');
      await page.getByText('No knowledge spaces', { exact: true }).waitFor();
      expect(await page.getByText(/Create the first space/).count()).toBeGreaterThan(0);
      await page.unroute('**/v1/knowledge/spaces**');

      const detailPath = `/v1/knowledge/spaces/${spaceId}`;
      await page.route(`**${detailPath}`, async (route) => {
        if (route.request().method() !== 'PATCH') {
          await route.continue();
          return;
        }
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            success: false,
            error: {
              code: 'KNOWLEDGE_VALIDATION_FAILED',
              message: 'UNIQUE_BACKEND_SECRET_9f217',
              retryable: false,
              details: { field: 'name' },
            },
            traceId: 'trace-i18n-secret',
            requestId: 'request-i18n-secret',
          }),
        });
      });
      await page.goto(`${baseUrl}/spaces/${spaceId}/overview`, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => document.documentElement.lang === 'en');
      const form = page.locator('form.form-band').first();
      await form.getByLabel('Name', { exact: true }).fill('English safe draft');
      await form.getByRole('button', { name: 'Save metadata' }).click();
      await page.locator('.problem-notice').waitFor();
      expect(await page.getByText('Request validation failed.', { exact: true }).count()).toBe(1);
      expect(await page.getByText(/trace trace-i18n-secret/).count()).toBe(1);
      expect(await page.getByText(/request request-i18n-secret/).count()).toBe(1);
      expect(await page.getByText('Not retryable', { exact: true }).count()).toBe(1);
      expect(await page.locator('body').textContent()).not.toContain('UNIQUE_BACKEND_SECRET_9f217');
      await page.close();
    } finally {
      await context.close();
      await browser.close();
    }
  });

  it('switches locale without changing route or query and persists it', async () => {
    const cookie = await consoleCookie();
    const separator = cookie.indexOf('=');
    const cookieName = separator > 0 ? cookie.slice(0, separator) : '';
    const cookieValue = separator > 0 ? cookie.slice(separator + 1) : '';
    if (!cookieName || !cookieValue) throw new Error('console cookie was not initialized');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 768, height: 1024 } });
    await context.addCookies([
      {
        name: cookieName,
        value: cookieValue,
        domain: '127.0.0.1',
        path: '/',
        sameSite: 'Strict',
      },
    ]);

    try {
      const page = await context.newPage();
      const path = `/spaces/${requiredId(scenario.spaceId, 'spaceId')}/segments?sourceId=${requiredId(scenario.sourceId, 'sourceId')}`;
      await page.goto(`${baseUrl}${path}`, { waitUntil: 'networkidle' });
      await page.getByRole('heading', { level: 1, name: '分段' }).waitFor();
      expect(await page.locator('html').getAttribute('lang')).toBe('zh-CN');
      const routeBefore = page.url();

      await page.getByRole('button', { name: 'EN' }).click();
      await page.waitForFunction(() => document.documentElement.lang === 'en');
      await page.getByRole('heading', { level: 1, name: 'Segments' }).waitFor();
      expect(page.url()).toBe(routeBefore);
      expect(await page.evaluate(() => window.localStorage.getItem('kb.locale'))).toBe('en');

      await page.reload({ waitUntil: 'networkidle' });
      await page.getByRole('heading', { level: 1, name: 'Segments' }).waitFor();
      expect(await page.locator('html').getAttribute('lang')).toBe('en');
      expect(page.url()).toBe(routeBefore);
      await page.close();
    } finally {
      await context.close();
      await browser.close();
    }
  });

  it('executes the 12 S2 file operations through HTTP and ticket auth', async () => {
    const spaceId = requiredId(scenario.spaceId, 'spaceId');
    const sourceId = requiredId(scenario.sourceId, 'sourceId');
    const partSize = 8 * 1024 * 1024;
    const first = Buffer.alloc(partSize, 'a');
    const second = Buffer.from('b');
    const session = asObject(
      await callApi('API-UPLOAD-INIT', {
        body: {
          knowledgeSpaceId: spaceId,
          name: 'runtime-file.txt',
          mimeType: 'text/plain',
          sizeBytes: first.byteLength + second.byteLength,
        },
      }),
    );
    const uploadId = asString(session.uploadId, 'uploadId');
    await callApi('API-UPLOAD-GET', { params: { uploadId } });
    const presigned = asObject(
      await callApi('API-UPLOAD-PRESIGN', {
        params: { uploadId },
        body: { partNumbers: [1, 2] },
      }),
    );
    expect(Array.isArray(presigned.uploads)).toBe(true);
    const partOne = asObject(
      await callBinaryApi('API-UPLOAD-PART', {
        params: { uploadId, partNumber: '1' },
        binary: first,
      }),
    );
    const partTwo = asObject(
      await callBinaryApi('API-UPLOAD-PART', {
        params: { uploadId, partNumber: '2' },
        binary: second,
      }),
    );
    const completed = asObject(
      await callApi('API-UPLOAD-COMPLETE', {
        params: { uploadId },
        body: {
          parts: [
            { partNumber: 1, etag: asString(partOne.etag, 'partOne.etag') },
            { partNumber: 2, etag: asString(partTwo.etag, 'partTwo.etag') },
          ],
        },
      }),
    );
    scenario.blobId = asString(completed.blobId, 'blobId');
    const source = await connections!.mongo.model('KnowledgeSource').findOneAndUpdate(
      { workspaceId, _id: sourceId, deletedAt: null },
      {
        $set: {
          blobRefId: scenario.blobId,
          mimeType: 'text/plain',
          sizeBytes: first.byteLength + second.byteLength,
        },
      },
      { new: true },
    );
    expect(source).not.toBeNull();
    await connections!.mongo
      .model('KnowledgeObjectRef')
      .updateOne({ workspaceId, _id: scenario.blobId }, { $set: { sourceId } });

    const filePreview = asObject(
      await callApi('API-FILE-PREVIEW', {
        params: { blobId: scenario.blobId },
        body: { disposition: 'inline' },
      }),
    );
    const fileDownload = asObject(
      await callApi('API-FILE-DOWNLOAD', {
        params: { blobId: scenario.blobId },
        body: { disposition: 'attachment' },
      }),
    );
    const normalContent = await fetch(`${baseUrl}/v1/knowledge/files/${scenario.blobId}/content`, {
      headers: {
        authorization: `Bearer ${authToken}`,
        'x-workspace-id': workspaceId,
        range: 'bytes=0-9',
      },
    });
    expect(normalContent.status).toBe(206);
    expect((await normalContent.arrayBuffer()).byteLength).toBe(10);
    covered.add('API-FILE-CONTENT');
    const ticketUrl = asString(filePreview.url, 'filePreview.url');
    const ticketContent = await fetch(ticketUrl, {
      headers: { range: 'bytes=0-9' },
    });
    expect(ticketContent.status).toBe(206);
    expect((await ticketContent.arrayBuffer()).byteLength).toBe(10);
    expect(asString(fileDownload.url, 'fileDownload.url')).toContain('ticket=');

    const sourcePreview = asObject(await callApi('API-SOURCE-PREVIEW', { params: { sourceId } }));
    expect(Array.isArray(sourcePreview.sections)).toBe(true);
    expect(asString(asObject(sourcePreview.sections[0]).text, 'preview.text')).toContain('a');
    await callApi('API-SOURCE-DOWNLOAD', {
      params: { sourceId },
      body: { disposition: 'attachment' },
    });
    const archive = asObject(
      await callApi('API-SOURCE-ARCHIVE', {
        params: { spaceId },
        body: { sourceIds: [sourceId] },
      }),
    );
    scenario.archiveJobId = asString(archive.jobId, 'archiveJobId');

    const abortSession = asObject(
      await callApi('API-UPLOAD-INIT', {
        body: {
          knowledgeSpaceId: spaceId,
          name: 'abort.txt',
          mimeType: 'text/plain',
          sizeBytes: 1,
        },
      }),
    );
    await callApi('API-UPLOAD-ABORT', {
      params: { uploadId: asString(abortSession.uploadId, 'abort.uploadId') },
      body: { version: asNumber(abortSession.version, 'abort.version') },
    });
  });

  it('finishes the delete paths, reads Jobs and proves all 65 baseline operations ran', async () => {
    await callApi('API-SEGMENT-DELETE', {
      params: { segmentId: requiredId(scenario.segmentId, 'segmentId') },
    });
    const sourceDelete = asObject(
      await callApi('API-SOURCE-DELETE', {
        params: { sourceId: requiredId(scenario.sourceId, 'sourceId') },
      }),
    );
    scenario.sourceDeleteJobId = asString(sourceDelete.jobId, 'source delete jobId');
    await callApi('API-DIRECTORY-DELETE', {
      params: { directoryId: requiredId(scenario.directoryId, 'directoryId') },
    });
    await callApi('API-TAG-DELETE', {
      params: { tagId: requiredId(scenario.tagId, 'tagId') },
    });

    const jobs = asObject(await callApi('API-JOB-LIST', { query: { limit: 200 } }));
    expect(jobs.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ jobId: scenario.sourceDeleteJobId, kind: 'delete' }),
      ]),
    );
    const job = asObject(
      await callApi('API-JOB-GET', {
        params: { jobId: scenario.sourceDeleteJobId },
      }),
    );
    expect(job.jobId).toBe(scenario.sourceDeleteJobId);

    const space = asObject(
      await callApi('API-SPACE-GET', {
        params: { spaceId: requiredId(scenario.spaceId, 'spaceId') },
      }),
    );
    await callApi('API-SPACE-DELETE', {
      params: { spaceId: requiredId(scenario.spaceId, 'spaceId') },
      body: {
        version: asNumber(space.version, 'space.version'),
        expectedReferenceRevision: asNumber(space.referenceRevision, 'space.referenceRevision'),
        referenceStrategy: 'block',
      },
    });

    expect(runtimeRegistry.count).toBe(102);
    const runtimeIds = new Set(
      runtimeRegistry.operations.map((operation) => operation.operationId),
    );
    expect([...covered].every((operationId) => runtimeIds.has(operationId))).toBe(true);
    expect(covered.size).toBe(65);
  });
});
