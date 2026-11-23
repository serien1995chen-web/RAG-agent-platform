import { describe, expect, it } from 'vitest';
import { legacyDatasetRedirect } from '../../src/lib/legacy-route';

type ImportTab = 'collectionCard' | 'dataCard' | 'test' | 'import';
type QueryValue = string | string[] | undefined;

async function resolveRedirect(tab: ImportTab, query: Record<string, QueryValue>) {
  const result = await legacyDatasetRedirect(tab)({ query } as never);
  if (!('redirect' in result)) {
    throw new Error('expected a redirect result');
  }
  return {
    destination: result.redirect.destination,
    permanent: result.redirect.permanent,
    url: new URL(result.redirect.destination, 'https://kb.example.test'),
  };
}

describe('legacy dataset import route', () => {
  it.each([
    ['file', 'fileLocal'],
    ['local', 'fileLocal'],
    ['url', 'fileLink'],
    ['link', 'fileLink'],
    ['text', 'fileCustom'],
    ['custom', 'fileCustom'],
    ['image', 'imageDataset'],
    ['template', 'template'],
    ['backup', 'backup'],
    ['retraining', 'reTraining'],
  ])('maps legacy kind %s to source %s', async (kind, source) => {
    const result = await resolveRedirect('import', { spaceId: 'space-1', kind });

    expect(result.url.pathname).toBe('/dataset/detail');
    expect(result.url.searchParams.get('datasetId')).toBe('space-1');
    expect(result.url.searchParams.get('currentTab')).toBe('import');
    expect(result.url.searchParams.get('source')).toBe(source);
    expect(result.permanent).toBe(false);
  });

  it('prefers an explicit source over the legacy kind mapping', async () => {
    const result = await resolveRedirect('import', {
      spaceId: 'space-1',
      kind: 'url',
      source: 'template',
    });

    expect(result.url.searchParams.get('source')).toBe('template');
  });

  it('preserves import context from the compatibility route', async () => {
    const result = await resolveRedirect('import', {
      spaceId: 'space-1',
      source: 'fileLink',
      parentId: 'directory-1',
      collectionId: 'collection-1',
      importJobId: 'job-1',
    });

    expect(result.url.searchParams.get('parentId')).toBe('directory-1');
    expect(result.url.searchParams.get('collectionId')).toBe('collection-1');
    expect(result.url.searchParams.get('importJobId')).toBe('job-1');
  });

  it('does not invent a source for an unknown legacy kind', async () => {
    const result = await resolveRedirect('import', { spaceId: 'space-1', kind: 'unknown' });

    expect(result.url.searchParams.has('source')).toBe(false);
  });

  it('returns to the knowledge list when the space id is missing', async () => {
    const result = await resolveRedirect('import', { kind: 'url' });

    expect(result.destination).toBe('/dataset/list');
    expect(result.permanent).toBe(false);
  });
});
