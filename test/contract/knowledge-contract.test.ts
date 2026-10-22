import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildKnowledgeContractArtifacts,
  RUNTIME_OPERATION_IDS,
} from '../../packages/contracts/src/openapi/openapi-builder.mjs';

const repoRoot = process.cwd();
const artifacts = buildKnowledgeContractArtifacts(repoRoot);
const document = artifacts.document as {
  components: {
    schemas: Record<string, unknown>;
    parameters: Record<string, unknown>;
    securitySchemes: Record<string, unknown>;
    responses: Record<string, unknown>;
  };
  paths: Record<string, Record<string, unknown>>;
};

function collectRefs(value: unknown, refs: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, refs);
    return refs;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === '$ref' && typeof item === 'string') refs.push(item);
      else collectRefs(item, refs);
    }
  }
  return refs;
}

function resolvePointer(ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  return ref
    .slice(2)
    .split('/')
    .reduce<unknown>((value, segment) => {
      if (value === null || typeof value !== 'object') return undefined;
      return (value as Record<string, unknown>)[
        segment.replaceAll('~1', '/').replaceAll('~0', '~')
      ];
    }, document);
}

describe('knowledge target contract', () => {
  it('freezes 92 paths, 120 operations, 139 schemas and 8 parameters', () => {
    expect(artifacts.actualCounts).toEqual({
      paths: 92,
      operations: 120,
      schemas: 139,
      parameters: 8,
    });
    expect(Object.keys(document.components.securitySchemes)).toEqual(['JWTAuth', 'APIKeyAuth']);
  });

  it('splits runtime 46 and deferred 74 with no overlap and full union', () => {
    expect(artifacts.runtimeRegistry.count).toBe(46);
    expect(artifacts.deferredManifest.count).toBe(74);
    const full = new Set(artifacts.fullRegistry.routes.map((route) => route.operationId));
    const runtime = new Set(artifacts.runtimeRegistry.operations.map((route) => route.operationId));
    const deferred = new Set(
      artifacts.deferredManifest.operations.map((route) => route.operationId),
    );
    expect([...runtime].sort()).toEqual([...RUNTIME_OPERATION_IDS].sort());
    expect([...runtime].filter((id) => deferred.has(id))).toEqual([]);
    expect(new Set([...runtime, ...deferred])).toEqual(full);
    expect(runtime.size + deferred.size).toBe(120);
  });

  it('resolves every component reference and uses only KNOWLEDGE errors', () => {
    const refs = collectRefs(document);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(resolvePointer(ref), ref).toBeDefined();

    const responseText = JSON.stringify(document.components.responses);
    for (const match of responseText.matchAll(/"code":"([^"]+)"/g)) {
      expect(match[1]).toMatch(/^KNOWLEDGE_/);
    }
    expect(responseText).not.toContain('501999');
  });

  it('contains 73 Capabilities, 23 collections, 4 vector profiles and 13 queues', () => {
    const manifest = JSON.parse(
      readFileSync(
        join(repoRoot, 'packages/contracts/src/knowledge/canonical-manifest.data.json'),
        'utf8',
      ),
    ) as {
      capabilities: unknown[];
      mongoCollections: string[];
      queues: string[];
      vectorProfiles: Array<{ dimension: number; storageType: string }>;
    };
    expect(manifest.capabilities).toHaveLength(73);
    expect(manifest.mongoCollections).toHaveLength(23);
    expect(manifest.mongoCollections.every((name) => name.startsWith('knowledge_'))).toBe(true);
    expect(manifest.queues).toHaveLength(13);
    expect(manifest.queues.every((name) => name.startsWith('knowledge-'))).toBe(true);
    expect(manifest.vectorProfiles).toEqual([
      expect.objectContaining({ dimension: 768, storageType: 'vector' }),
      expect.objectContaining({ dimension: 1024, storageType: 'vector' }),
      expect.objectContaining({ dimension: 1536, storageType: 'vector' }),
      expect.objectContaining({ dimension: 3072, storageType: 'halfvec' }),
    ]);
  });
});
