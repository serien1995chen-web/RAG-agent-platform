import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCompleteModelCatalog, type ModelCatalogPage } from '../../src/query/model-catalog';
import type { S5ModelView } from '../../src/components/s5-model-parse-state';

function model(index: number): S5ModelView {
  return {
    modelId: `model-${String(index).padStart(3, '0')}`,
    displayName: `Model ${index}`,
    type: 'llm',
    capabilities: ['chat'],
    authorized: true,
  };
}

describe('B09 full model catalog loader', () => {
  it('loads every page instead of truncating at 50 models', async () => {
    const models = Array.from({ length: 451 }, (_, index) => model(index));
    const paths: string[] = [];
    const catalog = await loadCompleteModelCatalog(async <T>(path: string) => {
      paths.push(path);
      const url = new URL(path, 'http://localhost');
      const cursor = url.searchParams.get('cursor');
      const start = cursor ? Number(cursor.slice('cursor-'.length)) : 0;
      const end = Math.min(start + 200, models.length);
      return {
        items: models.slice(start, end),
        pageInfo: {
          hasMore: end < models.length,
          nextCursor: end < models.length ? `cursor-${end}` : null,
        },
      } as T;
    });
    expect(catalog.items).toHaveLength(451);
    expect(catalog.items[0]?.modelId).toBe('model-000');
    expect(catalog.items.at(-1)?.modelId).toBe('model-450');
    expect(paths).toHaveLength(3);
    expect(paths.every((path) => path.includes('limit=200'))).toBe(true);
  });

  it('rejects a repeated cursor and a missing cursor while hasMore is true', async () => {
    await expect(
      loadCompleteModelCatalog(
        async <T>() =>
          ({
            items: [model(1)],
            pageInfo: { hasMore: true, nextCursor: 'same' },
          }) as T,
      ),
    ).rejects.toThrow('repeated nextCursor');
    await expect(
      loadCompleteModelCatalog(
        async <T>() =>
          ({
            items: [model(1)],
            pageInfo: { hasMore: true, nextCursor: null },
          }) as T,
      ),
    ).rejects.toThrow('missing nextCursor');
  });

  it('accepts the generated PageInfo response shape', () => {
    const page: ModelCatalogPage = {
      items: [model(1)],
      pageInfo: { hasMore: false, nextCursor: null },
    };
    expect(page.pageInfo).toEqual({ hasMore: false, nextCursor: null });
  });

  it('uses the shared full-catalog loader on New and Overview', () => {
    const root = join(
      import.meta.dirname,
      '..',
      '..',
      '..',
      '..',
      'projects',
      'app',
      'src',
      'pages',
      'spaces',
    );
    for (const path of [join(root, 'new.tsx'), join(root, '[spaceId]', 'overview.tsx')]) {
      const source = readFileSync(path, 'utf8');
      expect(source).toContain('useKnowledgeModelCatalog()');
      expect(source).not.toContain("'/v1/knowledge/models'");
    }
  });
});
