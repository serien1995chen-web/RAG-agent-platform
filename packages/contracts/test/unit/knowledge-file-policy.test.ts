import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_ACCEPT,
  DOCUMENT_FILE_EXTENSIONS,
  DOCUMENT_MIME_BY_EXTENSION,
  ImportFilesSchema,
  MAX_KNOWLEDGE_FILE_BYTES,
  MAX_LOCAL_IMPORT_FILES,
} from '../../src/index';

describe('knowledge file product policy', () => {
  it('freezes the FastGPT-compatible extension list and 5x50 MiB limits', () => {
    expect(MAX_LOCAL_IMPORT_FILES).toBe(5);
    expect(MAX_KNOWLEDGE_FILE_BYTES).toBe(50 * 1024 * 1024);
    expect(DOCUMENT_FILE_EXTENSIONS).toHaveLength(26);
    expect(DOCUMENT_ACCEPT).toContain('.doc');
    expect(DOCUMENT_ACCEPT).toContain('.wps');
    expect(DOCUMENT_ACCEPT).toContain('.epub');
    expect(
      DOCUMENT_FILE_EXTENSIONS.every(
        (extension) => DOCUMENT_MIME_BY_EXTENSION[extension].length > 0,
      ),
    ).toBe(true);
  });

  it('rejects a sixth local import before runtime processing', () => {
    expect(() =>
      ImportFilesSchema.parse({
        uploadIds: ['1', '2', '3', '4', '5', '6'],
        chunking: { trainingType: 'chunk', chunkSettingMode: 'auto' },
      }),
    ).toThrow();
  });
});
