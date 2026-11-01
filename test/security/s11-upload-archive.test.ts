import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { inspectArchiveBuffer } from '../../packages/parse/src/archive-safety';
import { FileApplication } from '../../packages/service/src/modules/knowledge/application/file.application';
import type {
  ObjectRefRepositoryPort,
  ObjectStoreApplicationPort,
} from '../../packages/service/src/modules/knowledge/application/ports';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const root = resolve(import.meta.dirname, '../..');
const fixtureRoot = join(root, 'test', 'fixtures', 's11', 'generated');
const context: TenantContext = {
  workspaceId: 'ws_s11_security',
  memberId: 'mem_s11_security',
  requestId: 'req_s11_security',
  traceId: 'trace_s11_security',
  scopes: ['knowledge:write'],
};

function fixture(name: string): Buffer {
  return readFileSync(join(fixtureRoot, name));
}

describe('TEST-X-SECURITY-UPLOAD', () => {
  it('rejects MIME and extension mismatch before creating an object reference', async () => {
    const objectRefs = {
      createUploadSession: vi.fn(),
    } as unknown as ObjectRefRepositoryPort;
    const objectStore = {
      ensureBucket: vi.fn(),
      createMultipartUpload: vi.fn(),
    } as unknown as ObjectStoreApplicationPort;
    const application = new FileApplication(
      objectRefs,
      objectStore,
      { getSpace: vi.fn() },
      { assertPermission: vi.fn() },
    );
    await expect(
      application.init(
        {
          knowledgeSpaceId: 'space-s11',
          name: 'report.pdf',
          mimeType: 'text/plain',
          sizeBytes: 10,
        },
        context,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_UNSUPPORTED_CONTENT' } },
    });
    expect(objectRefs.createUploadSession).not.toHaveBeenCalled();
    expect(objectStore.ensureBucket).not.toHaveBeenCalled();
    expect(objectStore.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('rejects zip bomb and zip-slip fixtures without marking them safe', async () => {
    const bomb = await inspectArchiveBuffer(fixture('s11-zip-bomb.zip'), {
      originalName: 'bomb.zip',
      container: 'zip',
    });
    expect(bomb.safe).toBe(false);
    expect([
      'entry_too_large',
      'total_uncompressed_too_large',
      'compression_ratio_exceeded',
      'archive_structure_invalid',
    ]).toContain(bomb.reason);

    const slip = await inspectArchiveBuffer(fixture('s11-zip-slip.zip'), {
      originalName: 'slip.zip',
      container: 'zip',
    });
    expect(slip.safe).toBe(false);
    expect(['entry_path_invalid', 'unsupported', 'archive_structure_invalid']).toContain(
      slip.reason,
    );
  });
});
