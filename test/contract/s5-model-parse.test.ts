import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const openapi = JSON.parse(
  readFileSync(
    join(root, 'packages', 'contracts', 'openapi', 'knowledge-target.openapi.json'),
    'utf8',
  ),
) as {
  paths: Record<string, Record<string, { operationId?: string }>>;
  components: { schemas: Record<string, unknown> };
};
const runtime = JSON.parse(
  readFileSync(
    join(root, 'packages', 'contracts', 'src', 'openapi', 'runtime-registry.data.json'),
    'utf8',
  ),
) as { operations: Array<{ operationId: string }> };
const deferred = JSON.parse(
  readFileSync(
    join(root, 'packages', 'contracts', 'src', 'openapi', 'deferred-manifest.data.json'),
    'utf8',
  ),
) as { operations: Array<{ operationId: string }> };

const S5_OPERATIONS = [
  'API-MODEL-LIST',
  'API-MODEL-BINDING-GET',
  'API-MODEL-BINDING-UPDATE',
  'API-MODEL-BINDING-VALIDATE',
] as const;
const S4_OPERATIONS = [
  'API-IMPORT-FILES',
  'API-IMPORT-TEXT',
  'API-IMPORT-URL',
  'API-IMPORT-TEMPLATE',
  'API-IMPORT-BACKUP',
  'API-IMPORT-API-CATALOG',
  'API-IMPORT-API-LIBRARY',
  'API-CONNECTOR-CONNECT',
  'API-CONNECTOR-CATALOG',
  'API-CONNECTOR-IMPORT',
  'API-CONNECTOR-SYNC',
  'API-CONNECTOR-UPDATE',
  'API-CONNECTOR-GET',
  'API-CONNECTOR-DELETE',
] as const;
const FORBIDDEN_LEGACY_FIELD = ['parse', 'Version'].join('');

describe('S5 model and parse frozen contract', () => {
  it('promotes exactly the four S5 operations to runtime', () => {
    const targetIds = Object.values(openapi.paths)
      .flatMap((methods) => Object.values(methods))
      .map((operation) => operation.operationId)
      .filter((id): id is string => typeof id === 'string');
    const runtimeIds = new Set(runtime.operations.map((operation) => operation.operationId));
    const deferredIds = new Set(deferred.operations.map((operation) => operation.operationId));
    for (const operationId of S5_OPERATIONS) {
      expect(targetIds).toContain(operationId);
      expect(runtimeIds.has(operationId)).toBe(true);
      expect(deferredIds.has(operationId)).toBe(false);
    }
  });

  it('exposes the frozen model and parse schemas without new public fields', () => {
    expect(openapi.components.schemas.ModelList).toBeDefined();
    expect(openapi.components.schemas.ModelBindingUpdate).toBeDefined();
    expect(openapi.components.schemas.ModelValidationResult).toBeDefined();
    expect(openapi.components.schemas.ParseProviderConfig).toBeDefined();
    expect(openapi.components.schemas.ChunkingSettings).toBeDefined();
    expect(openapi.components.schemas).not.toHaveProperty('ParseVersion');
  });

  it('covers six model types and four embedding dimensions', async () => {
    const { S5MockModelCatalog } =
      await import('../../packages/service/src/modules/knowledge/adapter/s5-aiproxy-catalog.adapter');
    const models = await new S5MockModelCatalog().listModels();
    expect(new Set(models.map((model) => model.type))).toEqual(
      new Set(['llm', 'embedding', 'rerank', 'vlm', 'stt', 'tts']),
    );
    expect(
      models
        .filter((model) => model.type === 'embedding')
        .map((model) => model.dimension)
        .sort((left, right) => Number(left) - Number(right)),
    ).toEqual([768, 1024, 1536, 3072]);
  });

  it('keeps the C2 handoff explicit and free of Segment/Job persistence', () => {
    const ports = readFileSync(
      join(
        root,
        'packages',
        'service',
        'src',
        'modules',
        'knowledge',
        'application',
        's5-processing-ports.ts',
      ),
      'utf8',
    );
    for (const field of [
      'sourceVersion',
      'rawText',
      'rawTextObjectRef',
      'pages',
      'assets',
      'diagnostics',
      'chunks',
      'qaItems',
      'evidence',
    ]) {
      expect(ports).toContain(field);
    }
    const application = readFileSync(
      join(
        root,
        'packages',
        'service',
        'src',
        'modules',
        'knowledge',
        'application',
        's5-processing.application.ts',
      ),
      'utf8',
    );
    expect(application).not.toMatch(
      /knowledge_segments|knowledge_jobs|SegmentRepository|JobRepository/,
    );
  });

  it('keeps the legacy field out of runtime source, schemas, generated OpenAPI and tests', () => {
    const roots = [
      join(root, 'packages', 'service', 'src'),
      join(root, 'packages', 'parse', 'src'),
      join(root, 'packages', 'chunk', 'src'),
      join(root, 'packages', 'qa', 'src'),
      join(root, 'packages', 'web', 'src'),
      join(root, 'test'),
    ];
    const files: string[] = [];
    const walk = (path: string) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) walk(child);
        else if (/\.(ts|tsx|json)$/.test(entry.name)) files.push(child);
      }
    };
    for (const path of roots) walk(path);
    const offenders = files.filter((file) =>
      readFileSync(file, 'utf8').includes(FORBIDDEN_LEGACY_FIELD),
    );
    expect(offenders).toEqual([]);
    const sourceSchema = readFileSync(
      join(
        root,
        'packages',
        'service',
        'src',
        'shared',
        'persistence',
        'schemas',
        'knowledge-catalog.schemas.ts',
      ),
      'utf8',
    );
    expect(sourceSchema).not.toContain(FORBIDDEN_LEGACY_FIELD);
    const openapiText = readFileSync(
      join(root, 'packages', 'contracts', 'openapi', 'knowledge-target.openapi.json'),
      'utf8',
    );
    expect(openapiText).not.toContain(FORBIDDEN_LEGACY_FIELD);
  });

  it('registers the four S5 operations without exposing an S6 worker consumer', () => {
    expect(runtime.operations).toHaveLength(83);
    expect(deferred.operations).toHaveLength(37);
    const worker = readFileSync(
      join(root, 'projects', 'app', 'src', 'runtime', 'knowledge-worker.ts'),
      'utf8',
    );
    expect(worker).not.toMatch(/s5|liteparse|S5ModelGateway|S5OcrApplication/);
  });

  it('keeps S4 14 and S5 4 operations in the W1 runtime union', () => {
    const runtimeIds = new Set(runtime.operations.map((operation) => operation.operationId));
    for (const operationId of [...S4_OPERATIONS, ...S5_OPERATIONS]) {
      expect(runtimeIds.has(operationId), operationId).toBe(true);
    }
  });
});
