import { KnowledgeApiError } from '@kb/contracts';
import {
  ArchiveSafetyInspector,
  ArchiveSafetySourceError,
  validateArchiveEntryPath,
} from '@kb/parse';
import type { ArchiveSafetyInput, ArchiveSafetyPort, ArchiveSafetyResult } from '@kb/service';

type ObjectStorageContext = ArchiveSafetyInput['storage'];

interface RangeReadableObjectStore {
  getObject(
    bucket: string,
    key: string,
    range: string | null,
    context: ObjectStorageContext,
  ): Promise<{
    body: AsyncIterable<Uint8Array>;
    size: number;
  }>;
}

const MAX_RANGE_READ_BYTES = 1024 * 1024;

export class ObjectStoreArchiveSafetyAdapter implements ArchiveSafetyPort {
  private readonly inspector = new ArchiveSafetyInspector();

  constructor(private readonly objectStore: RangeReadableObjectStore) {}

  validateEntryPath(value: string): { safe: true } | { safe: false; reason: string } {
    const reason = validateArchiveEntryPath(value);
    return reason === null ? { safe: true } : { safe: false, reason };
  }

  async inspect(input: ArchiveSafetyInput): Promise<ArchiveSafetyResult> {
    try {
      const inspected = await this.inspector.inspect({
        container: input.kind === 'archive' ? 'archive' : 'zip',
        originalName: input.originalName,
        ...(input.kind === 'archive' ? { limits: { maxEntries: 2001 } } : {}),
        ...(input.kind === 'space-archive' ? { limits: { maxEntries: 10_000 } } : {}),
        source: {
          size: input.sizeBytes,
          readRange: async (start, end) => {
            const length = end - start;
            if (length <= 0) return new Uint8Array();
            if (length > MAX_RANGE_READ_BYTES) {
              throw new ArchiveSafetySourceError('dependency_unavailable');
            }
            try {
              const range = await this.objectStore.getObject(
                input.bucket,
                input.objectKey,
                `bytes=${start}-${end - 1}`,
                input.storage,
              );
              const chunks: Buffer[] = [];
              let size = 0;
              for await (const chunk of range.body) {
                const buffer = Buffer.from(chunk);
                size += buffer.byteLength;
                if (size > length) {
                  throw new ArchiveSafetySourceError('dependency_unavailable');
                }
                chunks.push(buffer);
              }
              if (size !== length || range.size !== length) {
                throw new ArchiveSafetySourceError('dependency_unavailable');
              }
              return Buffer.concat(chunks, size);
            } catch (error) {
              if (error instanceof ArchiveSafetySourceError) throw error;
              if (error instanceof KnowledgeApiError) {
                if (error.problem.error.code === 'KNOWLEDGE_DEPENDENCY_TIMEOUT') {
                  throw new ArchiveSafetySourceError('dependency_timeout');
                }
                throw new ArchiveSafetySourceError('dependency_unavailable');
              }
              throw new ArchiveSafetySourceError('dependency_unavailable');
            }
          },
        },
      });
      return inspected;
    } catch (error) {
      if (error instanceof ArchiveSafetySourceError) {
        return {
          archive: true,
          safe: false,
          status: error.category,
          reason: error.category,
        };
      }
      throw error;
    }
  }
}
