import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
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
  type ObjectRefView,
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
  entries: Array<{
    path: string;
    sourceId: string;
    expectedSizeBytes: number;
    open(): Promise<Readable>;
  }>,
  manifest: Record<string, unknown>,
  context: TenantContext,
): Promise<{ directory: string; path: string; sizeBytes: number }> {
  const directory = await mkdtemp(join(tmpdir(), 'kb-archive-'));
  const path = join(directory, 'sources.zip');
  const output = createWriteStream(path);
  const completed = new Promise<void>((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', reject);
    archive.pipe(output);
    archive.append(`${JSON.stringify(manifest, null, 2)}\n`, { name: 'manifest.json' });
    let actualTotalBytes = 0;
    for (const entry of entries) {
      archive.append(
        Readable.from(
          (async function* sourceStream() {
            let actualEntryBytes = 0;
            for await (const chunk of await entry.open()) {
              const bytes = Buffer.from(chunk);
              actualEntryBytes += bytes.byteLength;
              actualTotalBytes += bytes.byteLength;
              if (actualTotalBytes > MAX_SOURCE_BYTES) {
                throw new ArchiveSafetyJobError({
                  archive: true,
                  safe: false,
                  status: 'too_large',
                  reason: 'total_uncompressed_too_large',
                });
              }
              yield bytes;
            }
            if (actualEntryBytes !== entry.expectedSizeBytes) {
              throw createKnowledgeError({
                code: 'KNOWLEDGE_PROVIDER_CONTRACT_INVALID',
                requestId: context.requestId,
                traceId: context.traceId,
                details: {
                  operation: 'archiveSourceRead',
                  sourceId: entry.sourceId,
                },
              });
            }
          })(),
        ),
        { name: entry.path },
      );
    }
    void archive.finalize().catch(reject);
  });
  try {
    await completed;
    const outputStat = await stat(path);
    return { directory, path, sizeBytes: outputStat.size };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
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
    objectStore?: MinioKnowledgeObjectStore,
  ) {
    const endpoint = new URL(config.s3.endpoint);
    this.archive = new KnowledgeArchiveRepository(connection);
    this.objectRefs = new KnowledgeObjectRefRepository(connection);
    this.objectStore =
      objectStore ??
      new MinioKnowledgeObjectStore({
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
    const entries: Array<{
      path: string;
      sourceId: string;
      expectedSizeBytes: number;
      open(): Promise<Readable>;
    }> = [];
    const manifestEntries: Array<{ sourceId: string; name: string; sizeBytes: number }> = [];
    let declaredTotalBytes = 0;
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
      const sourceId = String(source._id);
      if (
        !ref ||
        ref.state !== 'active' ||
        ref.sourceId !== sourceId ||
        ref.knowledgeSpaceId !== spaceId
      ) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_NOT_FOUND',
          requestId: context.requestId,
          traceId: context.traceId,
          details: { sourceId, reason: 'source_object_binding_invalid' },
        });
      }
      const entryPath = `sources/${sourceId}/${source.safeName}`;
      const validation = this.archiveSafety.validateEntryPath(entryPath);
      if (!validation.safe) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_UNSUPPORTED_CONTENT',
          requestId: context.requestId,
          traceId: context.traceId,
          details: { sourceId, reason: validation.reason },
        });
      }
      declaredTotalBytes += ref.sizeBytes;
      if (declaredTotalBytes > MAX_SOURCE_BYTES) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_PAYLOAD_TOO_LARGE',
          requestId: context.requestId,
          traceId: context.traceId,
          details: { limitBytes: MAX_SOURCE_BYTES },
        });
      }
      entries.push({
        path: entryPath,
        sourceId,
        expectedSizeBytes: ref.sizeBytes,
        open: async () => {
          const object = await this.objectStore.getObject(
            this.objectStore.bucket,
            ref.objectKey,
            null,
            storage,
          );
          return object.body;
        },
      });
      manifestEntries.push({
        sourceId,
        name: source.safeName,
        sizeBytes: ref.sizeBytes,
      });
    }
    manifestEntries.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
    const manifest = {
      version: 1,
      format: 'zip',
      generatedAt: new Date(0).toISOString(),
      entries: manifestEntries,
    };
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
    const existing = await this.objectRefs.findObjectRef(blobId, context);
    if (existing?.state === 'active') {
      await this.archive.commit(
        {
          jobId: String(job.jobId),
          workerId: this.workerId,
          attemptEpoch: Number(job.attemptEpoch),
          fencingToken: String(job.fencingToken),
          expectedVersion: Number(job.version),
          result: {
            objectBlobRefId: existing.blobId,
            expiresAt: existing.expiresAt,
            sourceCount: sources.length,
          },
        },
        context,
      );
      return;
    }
    if (existing) await this.cleanupArtifact(existing, storage, context);

    const zip = await buildZip(entries, manifest, context);
    let pending: ObjectRefView | undefined;
    try {
      pending = await this.objectRefs.createPendingArchiveArtifact(
        {
          blobId,
          knowledgeSpaceId: spaceId,
          provider: this.objectStore.provider,
          bucket: this.objectStore.bucket,
          objectKey: key,
          mimeType: 'application/zip',
          sizeBytes: zip.sizeBytes,
          expiresAt,
        },
        context,
      );
      const stored = await this.objectStore.putObject(
        {
          key,
          body: createReadStream(zip.path),
          sizeBytes: zip.sizeBytes,
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
      pending = await this.objectRefs.activateArchiveArtifact(
        {
          blobId,
          expectedVersion: pending.version,
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
            objectBlobRefId: pending.blobId,
            expiresAt: pending.expiresAt,
            sourceCount: sources.length,
          },
        },
        context,
      );
    } catch (error) {
      if (pending) {
        try {
          await this.cleanupArtifact(pending, storage, context);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'archive_cleanup_failed');
        }
      }
      throw error;
    } finally {
      await rm(zip.directory, { recursive: true, force: true });
    }
  }

  private async cleanupArtifact(
    artifact: ObjectRefView,
    storage: KnowledgeObjectContext,
    context: TenantContext,
  ): Promise<void> {
    let current = await this.objectRefs.findObjectRef(artifact.blobId, context);
    if (!current || current.state === 'deleted') return;
    if (current.state !== 'deleting') {
      current = await this.objectRefs.markDeleting(current.blobId, current.version, context);
    }
    await this.objectStore.deleteObject(current.objectKey, storage);
    await this.objectRefs.confirmDeleted(current.blobId, current.version, context);
  }
}
