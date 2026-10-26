import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const openapi = JSON.parse(
  readFileSync(
    join(repositoryRoot, 'packages/contracts/openapi/knowledge-target.openapi.json'),
    'utf8',
  ),
) as {
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components: { schemas: Record<string, Record<string, unknown>> };
};
const runtime = JSON.parse(
  readFileSync(
    join(repositoryRoot, 'packages/contracts/src/openapi/runtime-registry.data.json'),
    'utf8',
  ),
) as { count: number; operations: Array<{ operationId: string }> };

const S2_OPERATIONS = [
  'API-UPLOAD-INIT',
  'API-UPLOAD-PRESIGN',
  'API-UPLOAD-PART',
  'API-UPLOAD-COMPLETE',
  'API-UPLOAD-ABORT',
  'API-UPLOAD-GET',
  'API-FILE-PREVIEW',
  'API-FILE-CONTENT',
  'API-FILE-DOWNLOAD',
  'API-SOURCE-PREVIEW',
  'API-SOURCE-DOWNLOAD',
  'API-SOURCE-ARCHIVE',
];

describe('FILE OpenAPI and runtime contract', () => {
  it('keeps 92/120/139/8 and promotes exactly the 12 S2 operations', () => {
    const operations = Object.values(openapi.paths).flatMap((path) =>
      Object.values(path)
        .map((operation) => operation.operationId)
        .filter((id): id is string => typeof id === 'string'),
    );
    expect(Object.keys(openapi.paths)).toHaveLength(92);
    expect(operations).toHaveLength(120);
    expect(Object.keys(openapi.components.schemas)).toHaveLength(139);
    expect(runtime.count).toBe(65);
    expect(runtime.operations.map((operation) => operation.operationId)).toEqual(
      expect.arrayContaining(S2_OPERATIONS),
    );
  });

  it('requires knowledgeSpaceId and pins upload limits', () => {
    const uploadInit = openapi.components.schemas.UploadInit as {
      required: string[];
      properties: Record<string, Record<string, unknown>>;
    };
    expect(uploadInit.required).toContain('knowledgeSpaceId');
    expect(uploadInit.properties.name?.maxLength).toBe(180);
    expect(uploadInit.properties.sizeBytes?.maximum).toBe(1048576000);
    const presign = openapi.components.schemas.PresignUploadParts as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(presign.properties.partNumbers?.maxItems).toBe(10000);
  });

  it('allows content ticket authentication and Range without X-Workspace-Id', () => {
    const content = openapi.paths['/v1/knowledge/files/{blobId}/content']?.get as {
      parameters: Array<Record<string, unknown>>;
      security: Array<Record<string, unknown>>;
      responses: Record<string, unknown>;
    };
    const workspace = content.parameters.find((parameter) => parameter.name === 'X-Workspace-Id');
    const ticket = content.parameters.find((parameter) => parameter.name === 'ticket');
    const range = content.parameters.find((parameter) => parameter.name === 'Range');
    expect(workspace?.required).toBe(false);
    expect(ticket).toBeDefined();
    expect(range).toBeDefined();
    expect(content.security).toContainEqual({});
    expect(content.responses).toHaveProperty('416');
    expect(content.responses).toHaveProperty('503');
    expect(content.responses).toHaveProperty('504');
  });
});
