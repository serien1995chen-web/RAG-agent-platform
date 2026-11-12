import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const openapi = JSON.parse(
  readFileSync(join(root, 'packages/contracts/openapi/knowledge-target.openapi.json'), 'utf8'),
) as {
  components: { schemas: Record<string, Record<string, unknown>> };
};
const runtime = JSON.parse(
  readFileSync(join(root, 'packages/contracts/src/openapi/runtime-registry.data.json'), 'utf8'),
) as {
  operations: Array<{ operationId: string; capabilityIds: string[]; runtime: boolean }>;
};

function schema(name: string) {
  return openapi.components.schemas[name] as {
    required?: string[];
    properties?: Record<string, Record<string, unknown>>;
    additionalProperties?: boolean;
  };
}

describe('B05 DATA-004 and ING-002 public contract', () => {
  it('L1-B05-DATA-004-Q01 exposes runtime Segment create and batch operations', () => {
    const operations = new Map(runtime.operations.map((entry) => [entry.operationId, entry]));
    expect(operations.get('API-SEGMENT-CREATE')).toMatchObject({
      runtime: true,
      capabilityIds: expect.arrayContaining(['DATA-004']),
    });
    expect(operations.get('API-SEGMENT-BATCH')).toMatchObject({
      runtime: true,
      capabilityIds: expect.arrayContaining(['DATA-004']),
    });
    expect(operations.get('API-IMPORT-TEXT')).toMatchObject({
      runtime: true,
      capabilityIds: expect.arrayContaining(['ING-002']),
    });
  });

  it('L1-B05-DATA-004-N03 rejects unknown SegmentCreate fields in the public schema', () => {
    expect(schema('SegmentCreate').additionalProperties).toBe(false);
    expect(schema('SegmentBatchAction').additionalProperties).toBe(false);
    expect(schema('SegmentBatchAction').properties?.items).toMatchObject({
      items: { additionalProperties: false },
    });
  });

  it('L1-B05-ING-002-N02 defines every required ImportText request field', () => {
    const importText = schema('ImportText');
    expect(importText.required).toEqual(
      expect.arrayContaining(['knowledgeSpaceId', 'name', 'text', 'chunking']),
    );
    for (const field of importText.required ?? []) {
      expect(importText.properties, `missing ImportText property ${field}`).toHaveProperty(field);
    }
  });
});
