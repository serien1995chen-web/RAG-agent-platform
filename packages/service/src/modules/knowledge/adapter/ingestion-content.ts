import { randomBytes } from 'node:crypto';
import { createKnowledgeError } from '@kb/contracts';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type { ObjectRefView } from '../application/ports';
import type {
  ImportObjectDraft,
  ImportSourceDraft,
  IngestionContentResult,
  IngestionObjectStorePort,
  ProviderContent,
  UrlSnapshot,
} from '../application/ingestion.ports';
import { assertS8ImageMedia, isS8KnowledgeImage } from '../application/s8-image-policy';
import { sha256Of } from '../domain/import-submission';

function safeName(value: string): string {
  const normalized = value
    .normalize('NFKC')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
  return normalized || 'source';
}

function id(): string {
  return randomBytes(12).toString('hex');
}

function objectKey(input: {
  workspaceId: string;
  knowledgeSpaceId: string;
  sourceId: string;
  blobId: string;
  name: string;
}): string {
  return [
    'ws',
    input.workspaceId,
    'space',
    input.knowledgeSpaceId,
    'source',
    input.sourceId,
    'source',
    input.blobId,
    safeName(input.name),
  ].join('/');
}

export class KnowledgeIngestionContentAdapter {
  constructor(private readonly objectStore: IngestionObjectStorePort) {}

  async materialize(input: {
    kind: ImportSourceDraft['kind'];
    name: string;
    mimeType: string;
    bytes: Uint8Array;
    directoryId: string | null;
    parseProvider: ImportSourceDraft['parseProvider'];
    metadata: Record<string, unknown>;
    context: TenantContext;
    knowledgeSpaceId: string;
    connectorId?: string | null;
    externalId?: string | null;
  }): Promise<IngestionContentResult> {
    const sourceId = id();
    const blobId = id();
    const key = objectKey({
      workspaceId: input.context.workspaceId,
      knowledgeSpaceId: input.knowledgeSpaceId,
      sourceId,
      blobId,
      name: input.name,
    });
    const object = await this.objectStore.putObject(
      {
        key,
        body: input.bytes,
        sizeBytes: input.bytes.byteLength,
        contentType: input.mimeType,
        metadata: {
          sha256: sha256Of(input.bytes),
          'source-kind': input.kind,
        },
        workspaceId: input.context.workspaceId,
        knowledgeSpaceId: input.knowledgeSpaceId,
      },
      {
        workspaceId: input.context.workspaceId,
        knowledgeSpaceId: input.knowledgeSpaceId,
        requestId: input.context.requestId,
        traceId: input.context.traceId,
      },
    );
    const objectDraft: ImportObjectDraft = {
      id: blobId,
      provider: object.provider,
      bucket: object.bucket,
      objectKey: object.key,
      mimeType: input.mimeType,
      sizeBytes: object.size,
      etag: object.etag,
      sha256: object.sha256 || sha256Of(input.bytes),
    };
    return {
      createdObjectKey: object.key,
      source: {
        id: sourceId,
        kind: input.kind,
        name: input.name,
        directoryId: input.directoryId,
        blobRefId: blobId,
        externalId: input.externalId ?? null,
        connectorId: input.connectorId ?? null,
        mimeType: input.mimeType,
        sizeBytes: objectDraft.sizeBytes,
        contentHash: objectDraft.sha256,
        parseProvider: input.parseProvider,
        metadata: input.metadata,
        object: objectDraft,
      },
    };
  }

  async materializeText(input: {
    knowledgeSpaceId: string;
    directoryId: string | null;
    name: string;
    text: string;
    context: TenantContext;
  }): Promise<IngestionContentResult> {
    return this.materialize({
      kind: 'text',
      name: input.name,
      mimeType: 'text/plain; charset=utf-8',
      bytes: Buffer.from(input.text, 'utf8'),
      directoryId: input.directoryId,
      parseProvider: 'liteparse',
      metadata: { importedFrom: 'manual_text' },
      context: input.context,
      knowledgeSpaceId: input.knowledgeSpaceId,
    });
  }

  async materializeUrl(input: {
    knowledgeSpaceId: string;
    directoryId: string | null;
    selector: string;
    snapshot: UrlSnapshot;
    context: TenantContext;
  }): Promise<IngestionContentResult> {
    return this.materialize({
      kind: 'url',
      name: input.snapshot.title,
      mimeType: input.snapshot.contentType.split(';')[0] || 'text/html',
      bytes: input.snapshot.bytes,
      directoryId: input.directoryId,
      parseProvider: 'liteparse',
      metadata: {
        originalUrl: input.snapshot.safeUrl,
        urlHash: input.snapshot.urlHash,
        selector: input.selector,
      },
      context: input.context,
      knowledgeSpaceId: input.knowledgeSpaceId,
    });
  }

  async materializeProviderContent(input: {
    kind: 'api_library' | 'feishu' | 'yuque' | 'dingtalk';
    knowledgeSpaceId: string;
    directoryId: string | null;
    connectorId: string | null;
    content: ProviderContent;
    context: TenantContext;
  }): Promise<IngestionContentResult> {
    return this.materialize({
      kind: input.kind,
      name: input.content.title,
      mimeType: input.content.mimeType,
      bytes: input.content.bytes,
      directoryId: input.directoryId,
      parseProvider: 'liteparse',
      metadata: {
        providerStatus: 'EXTERNAL_UNVERIFIED',
        externalId: input.content.externalId,
      },
      context: input.context,
      knowledgeSpaceId: input.knowledgeSpaceId,
      connectorId: input.connectorId,
      externalId: input.content.externalId,
    });
  }

  async materializeTemplate(input: {
    knowledgeSpaceId: string;
    directoryId: string | null;
    name: string;
    mimeType: string;
    bytes: Uint8Array;
    rows: number;
    backup: boolean;
    context: TenantContext;
  }): Promise<IngestionContentResult> {
    return this.materialize({
      kind: input.backup ? 'backup' : 'template',
      name: input.name,
      mimeType: input.mimeType,
      bytes: input.bytes,
      directoryId: input.directoryId,
      parseProvider: 'liteparse',
      metadata: {
        rowCount: input.rows,
        validatedAt: new Date().toISOString(),
      },
      context: input.context,
      knowledgeSpaceId: input.knowledgeSpaceId,
    });
  }

  fileDraft(input: {
    object: ObjectRefView;
    directoryId: string | null;
    parseProvider: ImportSourceDraft['parseProvider'];
    metadata?: Record<string, unknown>;
  }): ImportSourceDraft {
    const image = isS8KnowledgeImage({
      mimeType: input.object.mimeType,
      fileName: input.object.originalName,
    });
    if (image) {
      assertS8ImageMedia(
        {
          mimeType: input.object.mimeType,
          fileName: input.object.originalName,
          sizeBytes: input.object.sizeBytes,
        },
        {
          requestId: 'ingestion-content',
          traceId: 'ingestion-content',
        },
      );
    }
    return {
      id: id(),
      kind: image ? 'image' : 'file',
      name: input.object.originalName,
      directoryId: input.directoryId,
      blobRefId: input.object.blobId,
      externalId: null,
      connectorId: null,
      mimeType: input.object.mimeType,
      sizeBytes: input.object.sizeBytes,
      contentHash: input.object.sha256,
      parseProvider: input.parseProvider,
      metadata: {
        importedFrom: 'upload',
        ...(image
          ? {
              imageMimeType: input.object.mimeType,
              imageSizeBytes: input.object.sizeBytes,
            }
          : {}),
        ...(input.metadata ?? {}),
      },
    };
  }

  async readObjectBytes(input: {
    ref: ObjectRefView;
    knowledgeSpaceId: string;
    maxBytes: number;
    context: TenantContext;
  }): Promise<Uint8Array> {
    const response = await this.objectStore.getObject(input.ref.bucket, input.ref.objectKey, null, {
      workspaceId: input.context.workspaceId,
      knowledgeSpaceId: input.knowledgeSpaceId,
      requestId: input.context.requestId,
      traceId: input.context.traceId,
    });
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > input.maxBytes) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_PAYLOAD_TOO_LARGE',
          requestId: input.context.requestId,
          traceId: input.context.traceId,
          details: { limitBytes: input.maxBytes },
        });
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async compensate(
    objectKey: string,
    knowledgeSpaceId: string,
    context: TenantContext,
  ): Promise<void> {
    await this.objectStore
      .deleteObject(objectKey, {
        workspaceId: context.workspaceId,
        knowledgeSpaceId,
        requestId: context.requestId,
        traceId: context.traceId,
      })
      .catch(() => undefined);
  }
}
