import { createHash } from 'node:crypto';
import type { ObjectStorePort } from '../../../ports/capabilities';
import type { ObjectRef, PortCallOptions, RequestContext } from '../../../ports/types';
import type { ReconcileFinding, S3ObjectDescriptor, S3OrphanScanner } from '../domain/findings';

const TWENTY_FOUR_HOURS_MS = 24 * 3_600_000;
const SEVEN_DAYS_MS = 7 * 24 * 3_600_000;
const DEFAULT_BATCH_LIMIT = 5000;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface S3TtlRecordView {
  id: string;
  teamId: string;
  bucketName: string;
  objectKey: string;
  expireAt: Date;
  attempt: number;
  operationId: string;
  resourceRef: { resourceType: string; resourceId: string; version: number };
}

export interface S3TtlStore {
  claimBatch(input: { now: Date; limit: number }): Promise<S3TtlRecordView[]>;
  markFailed(input: {
    id: string;
    teamId: string;
    attempt: number;
    nextAttemptAt: Date;
    now?: Date;
  }): Promise<boolean>;
  deleteRecord(input: { id: string; teamId: string }): Promise<boolean>;
  backfill(input: {
    teamId: string;
    bucketName: string;
    objectKey: string;
    expireAt: Date;
    operationId: string;
    resourceRef: { resourceType: string; resourceId: string; version: number };
  }): Promise<void>;
  hasFormalReference(input: {
    teamId: string;
    objectKey: string;
    datasetId?: string;
  }): Promise<boolean>;
  hasTtlRecord(input: { bucketName: string; objectKey: string }): Promise<boolean>;
  resolveDatasetTeamId(datasetId: string): Promise<string | null>;
}

/** 孤儿对象枚举（bootstrap 按 MinioObjectStore 判型注入；判型失败时缺省）。 */
export interface OrphanObjectLister {
  listByPrefix(input: { prefix: string; limit: number }): Promise<S3ObjectDescriptor[]>;
}

export interface S3TtlLogger {
  log(event: string, fields: Record<string, unknown>): void;
}

export interface S3TtlSweepStats {
  scanned: number;
  deleted: number;
  failed: number;
  skipped: number;
}

export interface S3TtlOrphanScanResult {
  findings: ReconcileFinding[];
  backfilled: number;
  pendingReview: number;
}

export interface S3TtlServiceDeps {
  repository: S3TtlStore;
  objectStore: ObjectStorePort;
  clock?: () => Date;
  logger?: S3TtlLogger;
  orphanObjectLister?: OrphanObjectLister;
  batchLimit?: number;
  timeoutMs?: number;
}

interface ParsedObjectKey {
  prefix: 'temp' | 'image' | 'dataset';
  scopeId: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function objectKeyHash16(objectKey: string): string {
  return sha256(objectKey).slice(0, 16);
}

function parseObjectKey(objectKey: string): ParsedObjectKey | null {
  const [prefix, scopeId] = objectKey.split('/');
  if (
    (prefix !== 'temp' && prefix !== 'image' && prefix !== 'dataset') ||
    scopeId === undefined ||
    scopeId === ''
  ) {
    return null;
  }
  return { prefix, scopeId };
}

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

/**
 * S3 TTL 清理服务（设计 10.9.1 / AB §4.3）：
 * sweepOnce：校验 → 引用复核 → abort → delete → 删记录；失败指数退避 ≤10 次；
 * scanOrphans：24h 宽限期、优先补写 TTL 记录、不可证明时 pending_review、永不删除正式引用对象。
 */
export class S3TtlService implements S3OrphanScanner {
  constructor(private readonly deps: S3TtlServiceDeps) {}

  async sweepOnce(context: RequestContext): Promise<S3TtlSweepStats> {
    const now = this.now();
    const stats: S3TtlSweepStats = { scanned: 0, deleted: 0, failed: 0, skipped: 0 };
    const batch = await this.deps.repository.claimBatch({
      now,
      limit: this.deps.batchLimit ?? DEFAULT_BATCH_LIMIT,
    });
    for (const record of batch) {
      stats.scanned += 1;
      const ref: ObjectRef = { bucket: '', key: record.objectKey };
      try {
        const parsed = parseObjectKey(record.objectKey);
        if (!parsed) {
          this.deps.logger?.log('s3-ttl.key_rejected', {
            objectKeyHash: objectKeyHash16(record.objectKey),
            reason: 'invalid_prefix',
          });
          await this.deps.repository.markFailed({
            id: record.id,
            teamId: record.teamId,
            attempt: record.attempt,
            nextAttemptAt: now,
            now,
          });
          stats.skipped += 1;
          continue;
        }
        const keyTeamId =
          parsed.prefix === 'dataset'
            ? await this.deps.repository.resolveDatasetTeamId(parsed.scopeId)
            : parsed.scopeId;
        if (keyTeamId === null) {
          this.deps.logger?.log('s3-ttl.key_rejected', {
            objectKeyHash: objectKeyHash16(record.objectKey),
            reason: 'dataset_unresolved',
          });
          await this.deps.repository.markFailed({
            id: record.id,
            teamId: record.teamId,
            attempt: record.attempt,
            nextAttemptAt: now,
            now,
          });
          stats.skipped += 1;
          continue;
        }
        if (keyTeamId !== record.teamId) {
          // 跨租户 key 拒绝并写安全审计；不删除对象，记录保留等待人工。
          this.deps.logger?.log('s3-ttl.tenant_rejected', {
            objectKeyHash: objectKeyHash16(record.objectKey),
            recordTeamId: record.teamId,
            keyTeamId,
          });
          await this.deps.repository.markFailed({
            id: record.id,
            teamId: record.teamId,
            attempt: record.attempt,
            nextAttemptAt: now,
            now,
          });
          stats.skipped += 1;
          continue;
        }
        const formal = await this.deps.repository.hasFormalReference({
          teamId: record.teamId,
          objectKey: record.objectKey,
          ...(parsed.prefix === 'dataset' ? { datasetId: parsed.scopeId } : {}),
        });
        if (formal) {
          // 已 promote/正式引用：只删除 TTL 记录，不删除对象。
          await this.deps.repository.deleteRecord({ id: record.id, teamId: record.teamId });
          stats.deleted += 1;
          continue;
        }
        const options = this.optionsOf(context);
        // 记录归属来自 TTL 事实源；按记录租户派生调用上下文，dataset/ 前缀同时授权 datasetId。
        const recordContext: RequestContext = {
          ...context,
          tenant: { ...context.tenant, teamId: record.teamId },
        };
        const deleteInput = {
          ref,
          options,
          ...(parsed.prefix === 'dataset' ? { datasetId: parsed.scopeId } : {}),
        };
        await this.deps.objectStore.abort(deleteInput, recordContext);
        await this.deps.objectStore.delete(deleteInput, recordContext);
        await this.deps.repository.deleteRecord({ id: record.id, teamId: record.teamId });
        stats.deleted += 1;
      } catch {
        const nextAttempt = record.attempt + 1;
        const backoffMs = Math.min(60_000 * 2 ** Math.max(0, nextAttempt - 1), 3_600_000);
        await this.deps.repository.markFailed({
          id: record.id,
          teamId: record.teamId,
          attempt: nextAttempt,
          nextAttemptAt: new Date(now.getTime() + backoffMs),
          now,
        });
        stats.failed += 1;
      }
    }
    return stats;
  }

  /** 供 P6-03 对账注入的扫描接口（仅枚举，不删除对象）。 */
  async listByPrefix(input: { prefix: string; limit: number }): Promise<S3ObjectDescriptor[]> {
    if (!this.deps.orphanObjectLister) return [];
    return this.deps.orphanObjectLister.listByPrefix(input);
  }

  /** 孤儿对象扫描与补写（S04）：宽限期 24h；补写 pending（expireAt=now+7d）。 */
  async scanOrphans(input: {
    now: Date;
    prefix?: string;
    limit?: number;
  }): Promise<S3TtlOrphanScanResult> {
    const findings: ReconcileFinding[] = [];
    let backfilled = 0;
    let pendingReview = 0;
    const lister = this.deps.orphanObjectLister;
    if (!lister) {
      findings.push({
        kind: 's3-orphan',
        sampleId: sha256('s3-scanner-unavailable'),
        hash: sha256(sha256('s3-scanner-unavailable')),
        action: 'pending_review',
      });
      return { findings, backfilled, pendingReview: 1 };
    }
    const prefixes = input.prefix ? [input.prefix] : ['temp/', 'image/', 'dataset/'];
    const limit = input.limit ?? this.deps.batchLimit ?? DEFAULT_BATCH_LIMIT;
    const now = input.now;
    for (const prefix of prefixes) {
      const objects = await lister.listByPrefix({ prefix, limit });
      for (const object of objects) {
        const sampleId = sha256(object.key);
        const parsed = parseObjectKey(object.key);
        if (!parsed) {
          pendingReview += 1;
          findings.push({
            kind: 's3-orphan',
            sampleId,
            hash: sha256(sampleId),
            action: 'pending_review',
          });
          continue;
        }
        const teamId =
          parsed.prefix === 'dataset'
            ? await this.deps.repository.resolveDatasetTeamId(parsed.scopeId)
            : parsed.scopeId;
        if (teamId === null || !OBJECT_ID_PATTERN.test(teamId)) {
          pendingReview += 1;
          findings.push({
            kind: 's3-orphan',
            sampleId,
            hash: sha256(sampleId),
            action: 'pending_review',
          });
          continue;
        }
        if (await this.deps.repository.hasTtlRecord({ bucketName: '', objectKey: object.key })) {
          continue;
        }
        if (
          await this.deps.repository.hasFormalReference({
            teamId,
            objectKey: object.key,
            ...(parsed.prefix === 'dataset' ? { datasetId: parsed.scopeId } : {}),
          })
        ) {
          continue;
        }
        if (!object.lastModified) {
          pendingReview += 1;
          findings.push({
            kind: 's3-orphan',
            sampleId,
            hash: sha256(sampleId),
            action: 'pending_review',
          });
          continue;
        }
        if (now.getTime() - object.lastModified.getTime() < TWENTY_FOUR_HOURS_MS) {
          continue;
        }
        try {
          await this.deps.repository.backfill({
            teamId,
            bucketName: '',
            objectKey: object.key,
            expireAt: new Date(now.getTime() + SEVEN_DAYS_MS),
            operationId: `s3ttl:${teamId}:${objectKeyHash16(object.key)}:backfill`,
            resourceRef: { resourceType: 'object', resourceId: object.key, version: 0 },
          });
          backfilled += 1;
          findings.push({
            kind: 's3-orphan',
            sampleId,
            hash: sha256(sampleId),
            action: 'backfill',
          });
        } catch {
          pendingReview += 1;
          findings.push({
            kind: 's3-orphan',
            sampleId,
            hash: sha256(sampleId),
            action: 'pending_review',
          });
        }
      }
    }
    return { findings, backfilled, pendingReview };
  }

  private optionsOf(context: RequestContext): PortCallOptions {
    return { timeoutMs: context.timeoutMs ?? this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS };
  }

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }
}
