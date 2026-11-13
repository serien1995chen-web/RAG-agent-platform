import { describe, expect, it } from 'vitest';
import { OPENAPI_DOCUMENT } from '../../src/index';

describe('B06 file access contract', () => {
  it('B06B-FILE-003-001 keeps internal storage fields out of Upload Complete', () => {
    const schemas = OPENAPI_DOCUMENT.components?.schemas as Record<
      string,
      { required?: string[]; properties?: Record<string, unknown> }
    >;
    const reference = schemas.ObjectBlobReference;

    expect(reference?.required).toEqual(['blobId', 'workspaceId', 'state', 'sizeBytes', 'etag']);
    expect(Object.keys(reference?.properties ?? {})).not.toContain('bucket');
    expect(Object.keys(reference?.properties ?? {})).not.toContain('objectKey');
  });

  it('B06A-XREF-001 allows read members to issue Source download tickets', () => {
    const path = OPENAPI_DOCUMENT.paths['/v1/knowledge/sources/{sourceId}/download'];
    expect(path?.post?.['x-required-scope']).toBe('knowledge:read');
  });

  it('B06A-FILE-003-001 allows read members to preview and download authorized files', () => {
    const preview = OPENAPI_DOCUMENT.paths['/v1/knowledge/files/{blobId}/preview'];
    const download = OPENAPI_DOCUMENT.paths['/v1/knowledge/files/{blobId}/download'];
    expect(preview?.post?.['x-required-scope']).toBe('knowledge:read');
    expect(download?.post?.['x-required-scope']).toBe('knowledge:read');
  });
});
