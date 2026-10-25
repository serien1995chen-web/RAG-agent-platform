import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import archiver from 'archiver';
import type { Connection } from 'mongoose';
import { createKnowledgeError } from '@kb/contracts';
import {
  KnowledgeArchiveRepository,
  KnowledgeObjectRefRepository,
  resolveSecretRef,
  type ArchiveSafetyPort,
  type ArchiveSafetyResult,
  type KnowledgeRuntimeConfig,
  type TenantContext,
} from '@kb/service';
import { knowledgeObjectKey, type KnowledgeObjectContext } from '@kb/storage/object-store-contract';
import { MinioKnowledgeObjectStore } from '@kb/storage/providers/minio';
import { ObjectStoreArchiveSafetyAdapter } from './archive-safety.adapter';

const EXPORT_TTL_MS = 3 * 60 * 60 * 1000;
const MAX_SOURCES = 2000;
const MAX_SOURCE_BYTES = 2048 * 1024 * 1024;

class ArchiveSafetyJobError extends Error {
  constructor(readonly inspection: ArchiveSafetyResult) {
    super(inspection.reason ?? inspection.status);
    this.name = 'ArchiveSafetyJobError';
  }
}

async function buildZip(
  entries: Array<{ path: string; bytes: Buffer }>,
  manifest: Record<string, unknown>,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    output.on('end', () => resolve(Buffer.concat(chunks)));
    output.on('error', reject);
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', reject);
    archive.pipe(output);
    archive.append(`${JSON.stringify(manifest, null, 2)}\n`, { name: 'manifest.json' });
    for (const entry of entries) archive.append(entry.bytes, { name: entry.path });
    void archive.finalize();
  });
}

function objectContext(context: TenantContext, knowledgeSpaceId: string): KnowledgeObjectContext {
  return {
    workspaceId: context.workspaceId,
    knowledgeSpaceId,
    requestId: context.requestId,
    traceId: context.traceId,
  };
}

export class KnowledgeArchiveWorker {
  private readonly archive: KnowledgeArchiveRepository;
  private readonly objectRefs: KnowledgeObjectRefRepository;
  private readonly objectStore: MinioKnowledgeObjectStore;
  private readonly archiveSafety: ArchiveSafetyPort;
  private readonly workerId: string;

  constructor(
    connection: Connection,
    config: KnowledgeRuntimeConfig,
    workerId: string,
    archiveSafety?: ArchiveSafetyPort,
  ) {
    const endpoint = new URL(config.s3.endpoint);
    this.archive = new KnowledgeArchiveRepository(connection);
    this.objectRefs = new KnowledgeObjectRefRepository(connection);
    this.objectStore = new MinioKnowledgeObjectStore({
      provider: 'minio',
      endPoint: endpoint.hostname,
      port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)),
      useSSL: endpoint.protocol === 'https:',
      accessKey: resolveSecretRef(config.s3.accessKeyRef),
      secretKey: resolveSecretRef(config.s3.secretKeyRef),
      region: config.s3.region,
      bucket: config.s3.bucket,
      credentialRefs: config.s3.credentialRefs,
    });
    this.archiveSafety = archiveSafety ?? new ObjectStoreArchiveSafetyAdapter(this.objectStore);
    this.workerId = workerId;
  }

  async runOnce(): Promise<number> {
    let processed = 0;
    for (const workspaceId of await this.archive.queuedWorkspaces()) {
      const context: TenantContext = {
        workspaceId,
        memberId: 'system:archive-worker',
        requestId: `archive:${Date.now()}`,
        traceId: `archive:${this.workerId}`,
        scopes: ['knowledge:admin'],
      };
      for (;;) {
        const claimed = await this.archive.claim(this.workerId, context);
        if (!claimed) break;
        const jobId = String(claimed.jobId);
        const started = await this.archive.start(
          {
            jobId,
            workerId: this.workerId,
            attemptEpoch: Number(claimed.attemptEpoch),
            fencingToken: String(claimed.fencingToken),
            expectedVersion: Number(claimed.version),
          },
          context,
        );
        try {
          await this.processJob(started, context);
          processed += 1;
        } catch (error) {
          const safetyError = error instanceof ArchiveSafetyJobError ? error.inspection : null;
          const retryable =
            safetyError?.status === 'dependency_unavailable' ||
            safetyError?.status === 'dependency_timeout' ||
            safetyError === null;
          await this.archive.fail(
            {
              jobId,
              workerId: this.workerId,
              attemptEpoch: Number(started.attemptEpoch),
              fencingToken: String(started.fencingToken),
              expectedVersion: Number(started.version),
              retryable,
            },
            context,
          );
          if (safetyError && !retryable) {
            await this.archive.markFailureCode(
              jobId,
              safetyError.status === 'too_large'
                ? 'KNOWLEDGE_PAYLOAD_TOO_LARGE'
                : 'KNOWLEDGE_UNSUPPORTED_CONTENT',
              context,
            );
          }
        }
      }
    }
    return processed;
  }

  private async processJob(job: Record<string, unknown>, context: TenantContext): Promise<void> {
    const snapshot =
      typeof job.inputSnapshot === 'object' && job.inputSnapshot !== null
        ? (job.inputSnapshot as Record<string, unknown>)
        : {};
    const sourceIds = Array.isArray(snapshot.sourceIds) ? snapshot.sourceIds.map(String) : [];
    if (sourceIds.length === 0 || sourceIds.length > MAX_SOURCES) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { field: 'sourceIds' },
      });
    }
    const sources = await this.archive.sources(sourceIds, context);
    if (sources.length !== sourceIds.length) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_NOT_FOUND',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { reason: 'source_archive_member_missing' },
      });
    }
    const totalBytes = sources.reduce((total, source) => total + Number(source.sizeBytes), 0);
    if (totalBytes > MAX_SOURCE_BYTES) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_PAYLOAD_TOO_LARGE',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { limitBytes: MAX_SOURCE_BYTES },
      });
    }
    const spaceId = String(job.knowledgeSpaceId ?? '');
    const storage = objectContext(context, spaceId);
    const entries: Array<{ path: string; bytes: Buffer }> = [];
    const manifestEntries: Array<{ sourceId: string; name: string; sizeBytes: number }> = [];
    for (const source of sources) {
      if (!source.blobRefId) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_NOT_FOUND',
          requestId: context.requestId,
          traceId: context.traceId,
          details: { sourceId: String(source._id), reason: 'source_object_missing' },
        });
      }
      const ref = await this.objectRefs.findObjectRef(String(source.blobRefId), context);
      if (!ref || ref.state !== 'active') {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_NOT_FOUND',
          requestId: context.requestId,
          traceId: context.traceId,
          details: { sourceId: String(source._id), reason: 'source_object_missing' },
        });
      }
      const object = await this.objectStore.getObject(
        this.objectStore.bucket,
        ref.objectKey,
        null,
        storage,
      );
      const chunks: Buffer[] = [];
      for await (const chunk of object.body) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      const sourceId = String(source._id);
      entries.push({
        path: `sources/${sourceId}/${source.safeName}`,
        bytes,
      });
      manifestEntries.push({
        sourceId,
        name: source.safeName,
        sizeBytes: bytes.byteLength,
      });
    }
    manifestEntries.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
    const manifest = {
      version: 1,
      format: 'zip',
      generatedAt: new Date(0).toISOString(),
      entries: manifestEntries,
    };
    const zip = await buildZip(entries, manifest);
    const blobId = createHash('sha1')
      .update(`archive:${String(job.jobId)}`)
      .digest('hex')
      .slice(0, 24);
    const key = knowledgeObjectKey({
      workspaceId: context.workspaceId,
      knowledgeSpaceId: spaceId,
      sourceId: 'unbound',
      purpose: 'export',
      blobId,
      safeName: 'sources.zip',
    });
    const expiresAt = new Date(Date.now() + EXPORT_TTL_MS);
    const stored = await this.objectStore.putObject(
      {
        key,
        body: zip,
        sizeBytes: zip.byteLength,
        contentType: 'application/zip',
        workspaceId: context.workspaceId,
        knowledgeSpaceId: spaceId,
        ttlExpireAt: expiresAt,
      },
      storage,
    );
    const inspected = await this.archiveSafety.inspect({
      kind: 'archive',
      bucket: stored.bucket,
      objectKey: stored.key,
      sizeBytes: stored.size,
      mimeType: 'application/zip',
      originalName: 'sources.zip',
      storage,
    });
    if (!inspected.archive || !inspected.safe) {
      await this.objectStore.deleteObject(stored.key, storage).catch(() => undefined);
      throw new ArchiveSafetyJobError(
        inspected.archive
          ? inspected
          : {
              archive: true,
              safe: false,
              status: 'unsupported',
              reason: 'archive_not_recognized',
            },
      );
    }
    const artifact = await this.objectRefs.createArchiveArtifact(
      {
        blobId,
        knowledgeSpaceId: spaceId,
        provider: stored.provider,
        bucket: stored.bucket,
        objectKey: key,
        mimeType: 'application/zip',
        sizeBytes: stored.size,
        etag: stored.etag,
        sha256: stored.sha256,
        expiresAt,
      },
      context,
    );
    await this.archive.commit(
      {
        jobId: String(job.jobId),
        workerId: this.workerId,
        attemptEpoch: Number(job.attemptEpoch),
        fencingToken: String(job.fencingToken),
        expectedVersion: Number(job.version),
        result: {
          objectBlobRefId: artifact.blobId,
          expiresAt: artifact.expiresAt,
          sourceCount: sources.length,
        },
      },
      context,
    );
  }
}
