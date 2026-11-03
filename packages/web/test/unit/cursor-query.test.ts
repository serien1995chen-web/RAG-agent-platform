import { describe, expect, it } from 'vitest';
import { buildCursorPagePath } from '../../src/query/use-cursor-knowledge-query';

describe('cursor pagination query construction', () => {
  it('uses only documented list parameters and preserves existing query values', () => {
    const path = buildCursorPagePath(
      {
        path: '/v1/knowledge/spaces?kind=space',
        limit: 50,
        sort: '-updatedAt',
        query: { status: 'active', omitted: undefined },
      },
      'cursor-2',
    );
    const url = new URL(path, 'http://knowledge.local');
    expect(url.pathname).toBe('/v1/knowledge/spaces');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      kind: 'space',
      limit: '50',
      sort: '-updatedAt',
      cursor: 'cursor-2',
      status: 'active',
    });
  });

  it('does not add a cursor for the first page', () => {
    const path = buildCursorPagePath({
      path: '/v1/knowledge/jobs',
      limit: 25,
      sort: '-updatedAt',
    });
    expect(path).toBe('/v1/knowledge/jobs?limit=25&sort=-updatedAt');
  });
});
