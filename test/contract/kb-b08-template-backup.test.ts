import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const matrix = JSON.parse(
  readFileSync(join(root, 'test/fixtures/b08/behavior-matrix.json'), 'utf8'),
) as {
  fastGptBaseline: { requestedVersion: string; observedVersion: string; authorization: string };
  capabilities: Array<{
    capabilityId: string;
    frontendBehaviorIds: string[];
    sourceRefs: string[];
    tracks: string[];
  }>;
};
const runtime = JSON.parse(
  readFileSync(join(root, 'packages/contracts/src/openapi/runtime-registry.data.json'), 'utf8'),
) as { operations: Array<{ operationId: string; capabilityIds: string[] }> };

describe('B08 behavior matrix and runtime contract', () => {
  it('binds ING-004 and ING-005 to executable import operations and all verdict tracks', () => {
    expect(matrix.fastGptBaseline).toMatchObject({
      requestedVersion: '4.17.3',
      observedVersion: '4.17.4',
      authorization: 'USER_AUTHORIZED_OBSERVED_VERSION',
    });
    expect(matrix.capabilities.map((entry) => entry.capabilityId)).toEqual(['ING-004', 'ING-005']);
    for (const capability of matrix.capabilities) {
      expect(capability.frontendBehaviorIds.length).toBeGreaterThan(0);
      expect(capability.sourceRefs.length).toBeGreaterThan(0);
      expect(capability.tracks).toEqual([
        'FASTGPT_PARITY',
        'PRODUCT_EXTENSION',
        'SECURITY_INVARIANT',
      ]);
      expect(
        runtime.operations.find((entry) => entry.capabilityIds.includes(capability.capabilityId)),
      ).toBeTruthy();
    }
  });
});
