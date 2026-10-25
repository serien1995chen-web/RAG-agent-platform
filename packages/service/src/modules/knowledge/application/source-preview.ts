import { createHash } from 'node:crypto';
import { createKnowledgeError } from '@kb/contracts';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type {
  AccessPort,
  ArchiveSafetyPort,
  CatalogPort,
  FileTicketPort,
  JobPort,
  ObjectRefRepositoryPort,
  ObjectStorageContext,
  ObjectStoreApplicationPort,
  SourceView,
} from './ports';

const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;
const MAX_ARCHIVE_SOURCES = 2000;
const MAX_ARCHIVE_SOURCE_BYTES = 2048 * 1024 * 1024;

function storageContext(source: SourceView, context: TenantContext): ObjectStorageContext {
  return {
    workspaceId: context.workspaceId,
    knowledgeSpaceId: source.knowledgeSpaceId,
    requestId: context.requestId,
    traceId: context.traceId,
  };
}

function conflict(context: TenantContext, details: Record<string, unknown>) {
  return createKnowledgeError({
    code: 'KNOWLEDGE_CONFLICT',
    requestId: context.requestId,
    traceId: context.traceId,
    details,
  });
}

function previewTooLarge(context: TenantContext) {
  return createKnowledgeError({
    code: 'KNOWLEDGE_PAYLOAD_TOO_LARGE',
    requestId: context.requestId,
    traceId: context.traceId,
    details: { limitBytes: MAX_PREVIEW_BYTES },
  });
}

function textMime(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/xml' ||
    mimeType.endsWith('+json') ||
    mimeType.endsWith('+xml')
  );
}

export class SourceFileApplication {
  constructor(
    private readonly catalog: CatalogPort,
    private readonly jobs: JobPort,
    private readonly access: AccessPort,
    private readonly objectRefs: ObjectRefRepositoryPort,
    private readonly objectStore: ObjectStoreApplicationPort,
    private readonly tickets: FileTicketPort,
    private readonly archiveSafety?: ArchiveSafetyPort,
  ) {}

  private async source(sourceId: string, context: TenantContext): Promise<SourceView> {
    const source = await this.catalog.getSource(sourceId, context);
    await this.access.assertPermission('source', sourceId, 'read', context);
    return source;
  }

  private async textFromObject(
    blobId: string,
    source: SourceView,
    context: TenantContext,
  ): Promise<string | null> {
    const ref = await this.objectRefs.findObjectRef(blobId, context);
    if (!ref || ref.state !== 'active') return null;
    const object = await this.objectStore.getObject(
      this.objectStore.bucket,
      ref.objectKey,
      null,
      storageContext(source, context),
    );
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of object.body) {
      const buffer = Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > MAX_PREVIEW_BYTES) throw previewTooLarge(context);
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async preview(
    sourceId: string,
    context: TenantContext,
  ): Promise<{
    sourceId: string;
    title: string;
    contentType: string;
    sections: Array<{ order: number; text: string }>;
  }> {
    const source = await this.source(sourceId, context);
    const parseJob = await this.jobs.findLatestSucceeded('parse', sourceId, context);
    const result =
      parseJob && typeof parseJob.result === 'object' && parseJob.result !== null
        ? (parseJob.result as Record<string, unknown>)
        : null;
    const rawTextBlobId = typeof result?.rawTextBlobId === 'string' ? result.rawTextBlobId : null;
    if (rawTextBlobId) {
      const text = await this.textFromObject(rawTextBlobId, source, context);
      if (text !== null) {
        return {
          sourceId,
          title: String(source.name ?? 'Source'),
          contentType: String(source.mimeType ?? 'text/plain'),
          sections: [{ order: 0, text }],
        };
      }
    }

    const sourceBlobId = typeof source.blobRefId === 'string' ? source.blobRefId : null;
    if (sourceBlobId && textMime(String(source.mimeType ?? ''))) {
      const text = await this.textFromObject(sourceBlobId, source, context);
      if (text !== null) {
        return {
          sourceId,
          title: String(source.name ?? 'Source'),
          contentType: String(source.mimeType ?? 'text/plain'),
          sections: [{ order: 0, text }],
        };
      }
    }

    const page = await this.catalog.listSegments(sourceId, { limit: 200, sort: 'order' }, context);
    const sections = page.items
      .map((segment) => ({
        order: Number(segment.order ?? 0),
        text: String(segment.content ?? segment.answer ?? segment.question ?? ''),
      }))
      .filter((section) => section.text.length > 0)
      .sort((left, right) => left.order - right.order)
      .slice(0, 200);
    if (sections.length === 0) {
      throw conflict(context, { reason: 'preview_not_ready' });
    }
    return {
      sourceId,
      title: String(source.name ?? 'Source'),
      contentType: String(source.mimeType ?? 'application/octet-stream'),
      sections,
    };
  }

  async download(
    sourceId: string,
    context: TenantContext,
  ): Promise<{
    ticketId: string;
    url: string;
    disposition: 'attachment';
    expiresAt: string;
  }> {
    const source = await this.source(sourceId, context);
    const blobId = typeof source.blobRefId === 'string' ? source.blobRefId : null;
    if (!blobId) throw conflict(context, { reason: 'source_object_missing' });
    const ref = await this.objectRefs.findObjectRef(blobId, context);
    if (!ref || ref.state !== 'active')
      throw conflict(context, { reason: 'source_object_missing' });
    const issued = this.tickets.issue(
      {
        workspaceId: ref.workspaceId,
        blobId: ref.blobId,
        sourceId: ref.sourceId,
        knowledgeSpaceId: null,
        disposition: 'attachment',
        ttlSeconds: 300,
      },
      context.requestId,
      context.traceId,
    );
    return {
      ticketId: createHash('sha256').update(issued.url).digest('hex').slice(0, 24),
      url: issued.url,
      disposition: 'attachment',
      expiresAt: issued.expiresAt,
    };
  }

  async archive(
    spaceId: string,
    sourceIds: string[],
    context: TenantContext,
  ): Promise<Record<string, unknown>> {
    await this.access.assertPermission('space', spaceId, 'write', context);
    const normalizedIds = [...new Set(sourceIds)];
    if (normalizedIds.length === 0 || normalizedIds.length > MAX_ARCHIVE_SOURCES) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_PAYLOAD_TOO_LARGE',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { field: 'sourceIds', min: 1, max: MAX_ARCHIVE_SOURCES },
      });
    }
    let totalBytes = 0;
    for (const sourceId of normalizedIds) {
      const source = await this.source(sourceId, context);
      if (this.archiveSafety) {
        const validation = this.archiveSafety.validateEntryPath(
          `sources/${sourceId}/${String(source.name ?? 'source')}`,
        );
        if (!validation.safe) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_UNSUPPORTED_CONTENT',
            requestId: context.requestId,
            traceId: context.traceId,
            details: { sourceId, reason: validation.reason },
          });
        }
      }
      if (source.knowledgeSpaceId !== spaceId) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_NOT_FOUND',
          requestId: context.requestId,
          traceId: context.traceId,
          details: { sourceId },
        });
      }
      totalBytes += Number(source.sizeBytes ?? 0);
    }
    if (totalBytes > MAX_ARCHIVE_SOURCE_BYTES) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_PAYLOAD_TOO_LARGE',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { limitBytes: MAX_ARCHIVE_SOURCE_BYTES },
      });
    }
    const idempotencyKey = `s2-export-${createHash('sha256')
      .update(`${spaceId}|${normalizedIds.join(',')}`)
      .digest('hex')}`;
    return this.jobs.createExportJob(
      { spaceId, sourceIds: normalizedIds, idempotencyKey },
      context,
    );
  }
}
