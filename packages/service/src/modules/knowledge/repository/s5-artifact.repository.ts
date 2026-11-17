import { createHash } from 'node:crypto';
import { Types, type ClientSession, type Connection, type Model } from 'mongoose';
import { createKnowledgeError } from '@kb/contracts';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import { requireWorkspaceId, tenantError } from '../../../shared/persistence/knowledge/tenant';
import { registerKnowledgeModels } from '../../../shared/persistence/schemas/knowledge-index';
import { withMongoTransaction } from '../../../shared/persistence/with-mongo-transaction';
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

interface StagedArtifact {
  blobId: Types.ObjectId;
  objectKey: string;
  purpose: 'source' | 'image';
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  etag: string;
  sourceId: string;
  knowledgeSpaceId: string;
  assetId?: string;
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
    'ws',
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

  private async stageOne(input: {
    sourceId: string;
    knowledgeSpaceId: string;
    purpose: 'source' | 'image';
    bytes: Uint8Array;
    mimeType: string;
    sha256: string;
    context: TenantContext;
    assetId?: string;
  }): Promise<
    | { existing: S5ObjectArtifactRef; staged?: undefined }
    | { existing?: undefined; staged: StagedArtifact }
  > {
    const workspaceId = requireWorkspaceId(input.context);
    const sourceObjectId = new Types.ObjectId(input.sourceId);
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
    if (existing?.state === 'active') {
      return { existing: objectRefView(existing) };
    }
    const objectKey = objectKeyOf({
      workspaceId,
      knowledgeSpaceId: input.knowledgeSpaceId,
      sourceId: input.sourceId,
      purpose: input.purpose,
      sha256: input.sha256,
      ...(input.assetId ? { assetId: input.assetId } : {}),
    });
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
    return {
      staged: {
        blobId,
        objectKey,
        purpose: input.purpose,
        sha256: stored.sha256 || input.sha256,
        sizeBytes: stored.size,
        mimeType: input.mimeType,
        etag: stored.etag || '',
        sourceId: input.sourceId,
        knowledgeSpaceId: input.knowledgeSpaceId,
        ...(input.assetId ? { assetId: input.assetId } : {}),
      },
    };
  }

  private async activateOne(
    staged: StagedArtifact,
    context: TenantContext,
    session: ClientSession,
  ): Promise<S5ObjectArtifactRef> {
    const workspaceId = requireWorkspaceId(context);
    const filter = { _id: staged.blobId, workspaceId, deletedAt: null };
    const update = {
      $set: {
        knowledgeSpaceId: new Types.ObjectId(staged.knowledgeSpaceId),
        sourceId: new Types.ObjectId(staged.sourceId),
        provider: this.store.provider,
        bucket: this.store.bucket,
        objectKey: staged.objectKey,
        purpose: staged.purpose,
        mimeType: staged.mimeType,
        sizeBytes: staged.sizeBytes,
        etag: staged.etag,
        sha256: staged.sha256,
        state: 'active',
        expiresAt: null,
        deletedAt: null,
        updatedByMemberId: context.memberId,
        'upload.mode': null,
        'upload.status': null,
        'upload.providerUploadId': null,
        'upload.pendingObjectKey': null,
        'upload.finalObjectKey': staged.objectKey,
        'upload.finalizedAt': new Date(),
        'upload.pendingUrlExpiresAt': null,
        'upload.partSizeBytes': 8_388_608,
        'upload.partCount': 0,
        'upload.parts': [],
        'upload.originalName':
          staged.purpose === 'source'
            ? `${staged.sourceId}.md`
            : `${staged.assetId ?? 'image'}.bin`,
        'upload.completedAt': null,
        'upload.abortedAt': null,
      },
      $setOnInsert: { createdByMemberId: context.memberId },
      $inc: { version: 1 },
    } as const;
    const updateActive = async (upsert: boolean) =>
      this.objects
        .findOneAndUpdate(filter, update, {
          upsert,
          new: true,
          setDefaultsOnInsert: true,
          session,
        })
        .lean<PlainObjectRef>()
        .exec();
    let active: PlainObjectRef | null;
    try {
      active = await updateActive(true);
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        (error as { code?: unknown }).code !== 11000
      ) {
        throw error;
      }
      active = await updateActive(false);
    }
    if (!active) {
      throw tenantError(context, 'KNOWLEDGE_CONFLICT', {
        reason: 'artifact_activation_conflict',
        blobId: String(staged.blobId),
      });
    }
    return objectRefView(active);
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
    const prepared = await this.stageOne({
      sourceId: input.sourceId,
      knowledgeSpaceId: input.knowledgeSpaceId,
      purpose: 'image',
      bytes: input.bytes,
      mimeType: input.mimeType,
      sha256: input.sha256,
      context,
      assetId: input.sha256,
    });
    const ref =
      prepared.existing ??
      (await withMongoTransaction(this.connection, (session) =>
        this.activateOne(prepared.staged, context, session),
      ));
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
    const rawPrepared = await this.stageOne({
      sourceId: input.sourceId,
      knowledgeSpaceId: input.knowledgeSpaceId,
      purpose: 'source',
      bytes: new TextEncoder().encode(input.parse.rawText),
      mimeType: 'text/markdown; charset=utf-8',
      sha256: rawTextHash,
      context,
    });
    const staged: StagedArtifact[] = rawPrepared.staged ? [rawPrepared.staged] : [];
    const assets: S5ParseAsset[] = [];
    for (const asset of input.parse.assets) {
      if (asset.objectRefId) {
        assets.push(asset);
        continue;
      }
      if (!asset.bytes || asset.bytes.byteLength === 0) {
        assets.push({ ...asset, bytes: undefined });
        continue;
      }
      const prepared = await this.stageOne({
        sourceId: input.sourceId,
        knowledgeSpaceId: input.knowledgeSpaceId,
        purpose: 'image',
        bytes: asset.bytes,
        mimeType: asset.mimeType,
        sha256: asset.sha256,
        context,
        assetId: asset.assetId,
      });
      if (prepared.staged) staged.push(prepared.staged);
      assets.push({
        assetId: asset.assetId,
        mimeType: asset.mimeType,
        sha256: asset.sha256,
        sizeBytes: asset.sizeBytes,
        ...(prepared.existing
          ? { objectRefId: prepared.existing.blobId }
          : prepared.staged
            ? { objectRefId: String(prepared.staged.blobId) }
            : {}),
      });
    }
    const activated = await withMongoTransaction(this.connection, async (session) => {
      const refs = new Map<string, S5ObjectArtifactRef>();
      for (const artifact of staged) {
        const ref = await this.activateOne(artifact, context, session);
        refs.set(ref.blobId, ref);
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
          { session },
        )
        .exec();
      if (updatedSource.matchedCount !== 1) {
        throw tenantError(context, 'KNOWLEDGE_CONFLICT', {
          reason: 'source_content_hash_cas_failed',
          sourceId: input.sourceId,
          sourceVersion: input.sourceVersion,
        });
      }
      return refs;
    });
    const rawTextObjectRef =
      rawPrepared.existing ??
      (rawPrepared.staged ? activated.get(String(rawPrepared.staged.blobId)) : undefined);
    if (!rawTextObjectRef) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_INTERNAL_ERROR',
        requestId: context.requestId,
        traceId: context.traceId,
        details: {
          reason: 'raw_text_artifact_not_activated',
          sourceId: input.sourceId,
          sourceVersion: input.sourceVersion,
        },
      });
    }
    const activatedAssets = assets.map((asset) =>
      asset.objectRefId && activated.has(asset.objectRefId)
        ? { ...asset, objectRefId: activated.get(asset.objectRefId)!.blobId }
        : asset,
    );
    const pages = input.parse.pages.map((page) => ({
      ...page,
      assets: page.assets.map(
        (asset) =>
          activatedAssets.find((candidate) => candidate.assetId === asset.assetId) ?? asset,
      ),
    }));
    return {
      sourceVersion: input.sourceVersion,
      rawTextObjectRef,
      pages,
      assets: activatedAssets,
      diagnostics: input.parse.diagnostics,
      evidence: {
        parserName: input.parse.format,
        parserVersion: input.parse.parserVersion,
        providerConfigHash: input.parse.configHash,
        rawTextHash: `sha256:${rawTextHash}`,
        ...(input.parse.requestEvidence ? { requestEvidence: input.parse.requestEvidence } : {}),
        ...(input.parse.attempts !== undefined ? { attempts: input.parse.attempts } : {}),
        ...(input.parse.fallbackUsed !== undefined
          ? { fallbackUsed: input.parse.fallbackUsed }
          : {}),
        ...(input.parse.actualProvider ? { actualProvider: input.parse.actualProvider } : {}),
        ...(input.parse.providerUsage ? { providerUsage: input.parse.providerUsage } : {}),
      },
    };
  }
}
