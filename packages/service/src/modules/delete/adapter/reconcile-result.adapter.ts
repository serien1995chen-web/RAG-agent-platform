import { ApiErrorException, createApiError } from '@kb/contracts';
import type { ReconcileResultPort } from '../../../ports/capabilities';
import type { PortCallOptions, RequestContext } from '../../../ports/types';

/** 报告仓储最小结构面（由 MongoReconcileReportRepository 提供）。 */
export interface ReconcileReportStoreLike {
  start(input: {
    dedupKey: string;
    scope: Record<string, unknown>;
    teamId: string | null;
    windowStart: Date;
    windowEnd: Date;
  }): Promise<void>;
  finish(input: {
    dedupKey: string;
    state: 'running' | 'completed' | 'failed' | 'pending_review';
    counts: { scanned: number; success: number; failed: number; skipped: number };
    findings: Array<{ kind: string; sampleId: string; hash: string; action: string }>;
    sampleHash: string;
  }): Promise<boolean>;
}

const REPORT_STATES = new Set(['running', 'completed', 'failed', 'pending_review']);

function invalidReport(dedupKey: string, requestId: string): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code: 501005,
      requestId,
      params: { taskId: dedupKey, from: 'report', to: 'invalid' },
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * ReconcileResultPort 适配器（E2）：接口签名零改动；
 * 入参 report/dedupKey → 报告仓储 upsert（running → 终态）。
 */
export class ReconcileResultAdapter implements ReconcileResultPort {
  constructor(private readonly reports: ReconcileReportStoreLike) {}

  async publish(
    input: { report: unknown; dedupKey: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ accepted: boolean }> {
    if (!isRecord(input.report) || typeof input.dedupKey !== 'string' || input.dedupKey === '') {
      throw invalidReport(input.dedupKey, context.requestId);
    }
    const report = input.report;
    const scope = isRecord(report['scope']) ? report['scope'] : {};
    const state = typeof report['state'] === 'string' ? report['state'] : 'completed';
    const windowStart = new Date(String(report['windowStart'] ?? ''));
    const windowEnd = new Date(String(report['windowEnd'] ?? ''));
    if (
      !REPORT_STATES.has(state) ||
      Number.isNaN(windowStart.getTime()) ||
      Number.isNaN(windowEnd.getTime())
    ) {
      throw invalidReport(input.dedupKey, context.requestId);
    }
    const counts = isRecord(report['counts'])
      ? {
          scanned: Number(report['counts']['scanned'] ?? 0),
          success: Number(report['counts']['success'] ?? 0),
          failed: Number(report['counts']['failed'] ?? 0),
          skipped: Number(report['counts']['skipped'] ?? 0),
        }
      : { scanned: 0, success: 0, failed: 0, skipped: 0 };
    const findings = Array.isArray(report['findings'])
      ? (report['findings'] as Array<{
          kind: string;
          sampleId: string;
          hash: string;
          action: string;
        }>)
      : [];
    const teamId = typeof report['teamId'] === 'string' ? report['teamId'] : null;
    await this.reports.start({
      dedupKey: input.dedupKey,
      scope,
      teamId,
      windowStart,
      windowEnd,
    });
    await this.reports.finish({
      dedupKey: input.dedupKey,
      state: state as 'running' | 'completed' | 'failed' | 'pending_review',
      counts,
      findings,
      sampleHash: typeof report['sampleHash'] === 'string' ? report['sampleHash'] : '',
    });
    return { accepted: true };
  }
}
