import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerKnowledgeModels } from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import { createKnowledgeConnections } from '../../packages/service/src/shared/runtime/knowledge-connections';

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
      ['/spaces', 'Knowledge spaces'],
      ['/spaces/new', 'New knowledge space'],
      [`/spaces/${requiredId(scenario.spaceId, 'spaceId')}/overview`, 'Space overview'],
      [`/spaces/${requiredId(scenario.spaceId, 'spaceId')}/sources`, 'Sources'],
      [`/spaces/${requiredId(scenario.spaceId, 'spaceId')}/segments`, 'Segments'],
      [`/spaces/${requiredId(scenario.spaceId, 'spaceId')}/tags`, 'Tags'],
      [`/spaces/${requiredId(scenario.spaceId, 'spaceId')}/access`, 'Access'],
      [`/spaces/${requiredId(scenario.spaceId, 'spaceId')}/jobs`, 'Jobs'],
      ['/system/status', 'System status'],
    ];
    for (const [path, title] of pages) {
      const response = await fetch(`${baseUrl}${path}`, {
        headers: { cookie },
        signal: AbortSignal.timeout(10_000),
      });
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toContain('text/html');
      const html = await response.text();
      expect(html, path).toMatch(new RegExp(`<title[^>]*>${title}</title>`));
      expect(html, path).toContain('<html lang="en">');
      expect(html, path).toContain('href="#knowledge-main"');
      expect(html, path).toContain('id="knowledge-main"');
      expect((html.match(/<h1\b/g) ?? []).length, `${path} h1 count`).toBe(1);
      expect(html, path).not.toMatch(/href="\/(?:search|synonyms|connectors|api-keys|models)/);
      expect(html, path).not.toContain('/api/core/dataset');
      expect(html, path).not.toContain('/api/internal/dataset');
      expect(html, path).not.toContain('/proApi/core/dataset');
    }
  });

  it('finishes the delete paths, reads Jobs and proves all 46 operations ran', async () => {
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

    expect(runtimeRegistry.count).toBe(46);
    expect([...covered].sort()).toEqual(
      runtimeRegistry.operations.map((operation) => operation.operationId).sort(),
    );
    expect(covered.size).toBe(46);
  });
});
