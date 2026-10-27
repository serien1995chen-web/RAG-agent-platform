import { createHash } from 'node:crypto';
import { Types, type Connection, type Model } from 'mongoose';
import { createKnowledgeError } from '@kb/contracts';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import { requireWorkspaceId, tenantError } from '../../../shared/persistence/knowledge/tenant';
import { registerKnowledgeModels } from '../../../shared/persistence/schemas/knowledge-index';
import type { KnowledgeObjectRefDoc } from '../../../shared/persistence/schemas/knowledge-operations.schemas';
import type { KnowledgeSourceDoc } from '../../../shared/persistence/schemas/knowledge-catalog.schemas';
import type {
  S5ArtifactMaterializeInput,
  S5ArtifactMaterializeResult,
  S5ArtifactStorePort,
  S5ObjectArtifactRef,
  S5ParseAsset,
} from '../application/s5-processing-ports';
import type { S5OcrAssetSinkPort } from '../application/s5-ocr-ports';

interface PlainObjectRef extends KnowledgeObjectRefDoc {
  _id: Types.ObjectId;
}

function stableObjectId(value: string): Types.ObjectId {
  return new Types.ObjectId(createHash('sha256').update(value).digest('hex').slice(0, 24));
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
}

function objectKeyOf(input: {
  workspaceId: string;
  knowledgeSpaceId: string;
  sourceId: string;
  purpose: 'source' | 'image';
  sha256: string;
  assetId?: string;
}): string {
  return [
    'workspace',
    safeSegment(input.workspaceId),
    'space',
    safeSegment(input.knowledgeSpaceId),
    'source',
    safeSegment(input.sourceId),
    input.purpose,
    ...(input.assetId ? [safeSegment(input.assetId)] : []),
    safeSegment(input.sha256),
  ].join('/');
}

function objectRefView(document: PlainObjectRef): S5ObjectArtifactRef {
  return {
    blobId: String(document._id),
    objectKey: document.objectKey,
    purpose: document.purpose === 'image' ? 'image' : 'source',
    sha256: document.sha256,
    sizeBytes: document.sizeBytes,
  };
}

export class S5ArtifactRepository implements S5OcrAssetSinkPort {
  private readonly objects: Model<KnowledgeObjectRefDoc>;
  private readonly sources: Model<KnowledgeSourceDoc>;

  constructor(
    private readonly connection: Connection,
    private readonly store: S5ArtifactStorePort,
  ) {
    const models = registerKnowledgeModels(connection);
    this.objects = models.KnowledgeObjectRef;
    this.sources = models.KnowledgeSource;
  }

  private async materializeOne(input: {
    sourceId: string;
    sourceVersion: number;
    knowledgeSpaceId: string;
    purpose: 'source' | 'image';
    bytes: Uint8Array;
    mimeType: string;
    sha256: string;
    context: TenantContext;
    assetId?: string;
  }): Promise<S5ObjectArtifactRef> {
    const workspaceId = requireWorkspaceId(input.context);
    const sourceObjectId = new Types.ObjectId(input.sourceId);
    const knowledgeSpaceObjectId = new Types.ObjectId(input.knowledgeSpaceId);
    const blobId = stableObjectId(
      [
        workspaceId,
        input.knowledgeSpaceId,
        input.sourceId,
        input.purpose,
        input.assetId ?? 'raw',
        input.sha256,
      ].join('|'),
    );
    const existing = await this.objects
      .findOne({
        _id: blobId,
        workspaceId,
        sourceId: sourceObjectId,
        purpose: input.purpose,
        sha256: input.sha256,
        deletedAt: null,
      })
      .lean<PlainObjectRef>()
      .exec();
    if (existing?.state === 'active') return objectRefView(existing);
    const objectKey = objectKeyOf({
      workspaceId,
      knowledgeSpaceId: input.knowledgeSpaceId,
      sourceId: input.sourceId,
      purpose: input.purpose,
      sha256: input.sha256,
      ...(input.assetId ? { assetId: input.assetId } : {}),
    });
    let pending: PlainObjectRef;
    if (existing) {
      const updated = await this.objects
        .findOneAndUpdate(
          {
            _id: blobId,
            workspaceId,
            version: existing.version,
            deletedAt: null,
          },
          {
            $set: {
              state: 'pending',
              objectKey,
              mimeType: input.mimeType,
              sizeBytes: input.bytes.byteLength,
              etag: '',
              sha256: input.sha256,
              expiresAt: null,
              'upload.mode': null,
              'upload.status': null,
              'upload.providerUploadId': null,
              'upload.pendingObjectKey': null,
              'upload.finalObjectKey': objectKey,
              'upload.finalizedAt': null,
              'upload.pendingUrlExpiresAt': null,
              'upload.partSizeBytes': 8_388_608,
              'upload.partCount': 0,
              'upload.parts': [],
              'upload.originalName':
                input.purpose === 'source'
                  ? `${input.sourceId}.md`
                  : `${input.assetId ?? 'image'}.bin`,
              'upload.completedAt': null,
              'upload.abortedAt': null,
              updatedByMemberId: input.context.memberId,
            },
            $inc: { version: 1 },
          },
          { new: true },
        )
        .lean<PlainObjectRef>()
        .exec();
      if (!updated) {
        throw tenantError(input.context, 'KNOWLEDGE_CONFLICT', {
          reason: 'artifact_reset_conflict',
          blobId: String(blobId),
        });
      }
      pending = updated;
    } else {
      const created = await this.objects.create({
        _id: blobId,
        workspaceId,
        knowledgeSpaceId: knowledgeSpaceObjectId,
        version: 1,
        deletedAt: null,
        createdByMemberId: input.context.memberId,
        updatedByMemberId: input.context.memberId,
        provider: this.store.provider,
        bucket: this.store.bucket,
        objectKey,
        purpose: input.purpose,
        sourceId: sourceObjectId,
        mimeType: input.mimeType,
        sizeBytes: input.bytes.byteLength,
        etag: '',
        sha256: input.sha256,
        state: 'pending',
        expiresAt: null,
        upload: {
          mode: null,
          status: null,
          providerUploadId: null,
          pendingObjectKey: null,
          finalObjectKey: objectKey,
          finalizedAt: null,
          pendingUrlExpiresAt: null,
          partSizeBytes: 8_388_608,
          partCount: 0,
          parts: [],
          originalName:
            input.purpose === 'source' ? `${input.sourceId}.md` : `${input.assetId ?? 'image'}.bin`,
          completedAt: null,
          abortedAt: null,
        },
      });
      pending = created.toObject<PlainObjectRef>();
    }
    try {
      const stored = await this.store.putObject(
        {
          key: objectKey,
          body: input.bytes,
          contentType: input.mimeType,
          workspaceId,
          knowledgeSpaceId: input.knowledgeSpaceId,
          purpose: input.purpose,
          sha256: input.sha256,
        },
        input.context,
      );
      const active = await this.objects
        .findOneAndUpdate(
          {
            _id: blobId,
            workspaceId,
            version: pending.version,
            state: 'pending',
            deletedAt: null,
          },
          {
            $set: {
              state: 'active',
              objectKey: stored.key,
              sizeBytes: stored.size,
              etag: stored.etag,
              sha256: stored.sha256 || input.sha256,
              'upload.finalObjectKey': stored.key,
              'upload.finalizedAt': new Date(),
              updatedByMemberId: input.context.memberId,
            },
            $inc: { version: 1 },
          },
          { new: true },
        )
        .lean<PlainObjectRef>()
        .exec();
      if (!active) {
        throw tenantError(input.context, 'KNOWLEDGE_CONFLICT', {
          reason: 'artifact_activation_conflict',
          blobId: String(blobId),
        });
      }
      return objectRefView(active);
    } catch (error) {
      await this.objects
        .updateOne(
          {
            _id: blobId,
            workspaceId,
            version: pending.version,
          },
          {
            $set: {
              state: 'deleting',
              expiresAt: new Date(Date.now() + 3 * 60 * 60 * 1000),
              updatedByMemberId: input.context.memberId,
            },
            $inc: { version: 1 },
          },
        )
        .exec();
      throw error;
    }
  }

  private async materializeAsset(
    asset: S5ParseAsset,
    input: S5ArtifactMaterializeInput,
    context: TenantContext,
  ): Promise<S5ParseAsset> {
    if (asset.objectRefId) return asset;
    if (!asset.bytes || asset.bytes.byteLength === 0) {
      return {
        ...asset,
        bytes: undefined,
      };
    }
    const ref = await this.materializeOne({
      sourceId: input.sourceId,
      sourceVersion: input.sourceVersion,
      knowledgeSpaceId: input.knowledgeSpaceId,
      purpose: 'image',
      bytes: asset.bytes,
      mimeType: asset.mimeType,
      sha256: asset.sha256,
      context,
      assetId: asset.assetId,
    });
    return {
      assetId: asset.assetId,
      mimeType: asset.mimeType,
      sha256: asset.sha256,
      sizeBytes: asset.sizeBytes,
      objectRefId: ref.blobId,
    };
  }

  async putImage(
    input: {
      workspaceId: string;
      knowledgeSpaceId: string;
      sourceId: string;
      sourceVersion: number;
      bytes: Uint8Array;
      mimeType: string;
      sha256: string;
    },
    context: TenantContext,
  ): Promise<{ objectRefId: string; markdownUrl: string }> {
    const ref = await this.materializeOne({
      sourceId: input.sourceId,
      sourceVersion: input.sourceVersion,
      knowledgeSpaceId: input.knowledgeSpaceId,
      purpose: 'image',
      bytes: input.bytes,
      mimeType: input.mimeType,
      sha256: input.sha256,
      context,
      assetId: input.sha256,
    });
    return {
      objectRefId: ref.blobId,
      markdownUrl: `object://${ref.blobId}`,
    };
  }

  async materialize(
    input: S5ArtifactMaterializeInput,
    context: TenantContext,
  ): Promise<S5ArtifactMaterializeResult> {
    const workspaceId = requireWorkspaceId(context);
    if (!Types.ObjectId.isValid(input.sourceId)) {
      throw tenantError(context, 'KNOWLEDGE_NOT_FOUND', { sourceId: input.sourceId });
    }
    if (!Types.ObjectId.isValid(input.knowledgeSpaceId)) {
      throw tenantError(context, 'KNOWLEDGE_VALIDATION_FAILED', {
        field: 'knowledgeSpaceId',
      });
    }
    if (!Number.isInteger(input.sourceVersion) || input.sourceVersion < 1) {
      throw tenantError(context, 'KNOWLEDGE_VALIDATION_FAILED', {
        field: 'sourceVersion',
        min: 1,
      });
    }
    if (input.parse.rawText.trim().length === 0) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_UNSUPPORTED_CONTENT',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { reason: 'empty_raw_text' },
      });
    }
    const source = await this.sources
      .findOne({
        _id: new Types.ObjectId(input.sourceId),
        workspaceId,
        knowledgeSpaceId: new Types.ObjectId(input.knowledgeSpaceId),
        sourceVersion: input.sourceVersion,
        deletedAt: null,
      })
      .lean<KnowledgeSourceDoc>()
      .exec();
    if (!source) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_NOT_FOUND',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { sourceId: input.sourceId, sourceVersion: input.sourceVersion },
      });
    }
    const rawTextHash = createHash('sha256').update(input.parse.rawText, 'utf8').digest('hex');
    const rawTextObjectRef = await this.materializeOne({
      sourceId: input.sourceId,
      sourceVersion: input.sourceVersion,
      knowledgeSpaceId: input.knowledgeSpaceId,
      purpose: 'source',
      bytes: new TextEncoder().encode(input.parse.rawText),
      mimeType: 'text/markdown; charset=utf-8',
      sha256: rawTextHash,
      context,
    });
    const assets: S5ParseAsset[] = [];
    for (const asset of input.parse.assets) {
      const materialized = await this.materializeAsset(asset, input, context);
      assets.push(materialized);
    }
    const updatedSource = await this.sources
      .updateOne(
        {
          _id: new Types.ObjectId(input.sourceId),
          workspaceId,
          sourceVersion: input.sourceVersion,
          deletedAt: null,
        },
        {
          $set: {
            contentHash: rawTextHash,
            updatedByMemberId: context.memberId,
          },
        },
      )
      .exec();
    if (updatedSource.modifiedCount !== 1) {
      throw tenantError(context, 'KNOWLEDGE_CONFLICT', {
        reason: 'source_content_hash_cas_failed',
        sourceId: input.sourceId,
        sourceVersion: input.sourceVersion,
      });
    }
    const pages = input.parse.pages.map((page) => ({
      ...page,
      assets: page.assets.map(
        (asset) => assets.find((candidate) => candidate.assetId === asset.assetId) ?? asset,
      ),
    }));
    return {
      sourceVersion: input.sourceVersion,
      rawTextObjectRef,
      pages,
      assets,
      diagnostics: input.parse.diagnostics,
      evidence: {
        parserName: input.parse.format,
        parserVersion: input.parse.parserVersion,
        providerConfigHash: input.parse.configHash,
        rawTextHash: `sha256:${rawTextHash}`,
      },
    };
  }
}
