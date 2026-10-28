import { createKnowledgeError } from '@kb/contracts';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type { S6JobPort } from './s06-processing-ports';
import { rebuildResult, type SynonymRebuildPlan } from '../domain/s09-synonym-rebuild';
import type { S09S6RebuildPort, S09SynonymRepositoryPort } from './s09-synonym.ports';

export interface S09RebuildApplicationDependencies {
  repository: Pick<S09SynonymRepositoryPort, 'getRebuildPlan' | 'completeRebuild' | 'failRebuild'>;
  s6: S09S6RebuildPort;
  jobs: Pick<S6JobPort, 'getRaw' | 'claimById' | 'start' | 'setStep'>;
}

function problemCode(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'problem' in error &&
    typeof (error as { problem?: { error?: { code?: unknown } } }).problem?.error?.code === 'string'
  ) {
    return String((error as { problem: { error: { code: string } } }).problem.error.code);
  }
  return 'KNOWLEDGE_INTERNAL_ERROR';
}

function retryable(error: unknown): boolean {
  return Boolean(
    typeof error === 'object' &&
    error !== null &&
    'problem' in error &&
    (error as { problem?: { error?: { retryable?: unknown } } }).problem?.error?.retryable,
  );
}

function failureEvidence(error: unknown, stage: string): Record<string, unknown> {
  return {
    stage,
    code: problemCode(error),
    errorType: error instanceof Error ? error.name : typeof error,
  };
}

export class S09RebuildApplication {
  constructor(private readonly input: S09RebuildApplicationDependencies) {}

  private async execute(
    plan: SynonymRebuildPlan,
    context: TenantContext,
  ): Promise<'succeeded' | 'retry' | 'dead_letter'> {
    let staged: Awaited<ReturnType<S09S6RebuildPort['stageProfile']>> | undefined;
    try {
      staged = await this.input.s6.stageProfile(plan, context);
      staged = await this.input.s6.reuseOrBuildVector(plan, staged, context);
      await this.input.jobs.setStep(
        {
          jobId: plan.jobId,
          stepKey: 'stage-synonym-index',
          status: 'succeeded',
          idempotencyKey: `s9-stage:${plan.jobId}:${plan.candidateFileVersion}`,
          evidence: {
            stagingId: staged.stagingId,
            sourceCount: staged.sourceIds.length,
            indexedSegmentVersions: staged.indexedSegmentVersions,
            rebuiltCount: staged.rebuiltCount,
            reusedVectorCount: staged.reusedVectorCount,
            cleanupCandidateCount: staged.cleanupCandidates.length,
          },
        },
        context,
      );
      staged = await this.input.s6.finalize(plan, staged, context);
      await this.input.jobs.setStep(
        {
          jobId: plan.jobId,
          stepKey: 'switch-synonym-index',
          status: 'succeeded',
          idempotencyKey: `s9-switch:${plan.jobId}:${plan.candidateFileVersion}`,
          evidence: {
            indexedSegmentVersions: staged.indexedSegmentVersions,
            cleanupCandidateCount: staged.cleanupCandidates.length,
          },
        },
        context,
      );
      const result = rebuildResult(plan, staged);
      await this.input.repository.completeRebuild(plan, staged, result, context);
      return 'succeeded';
    } catch (error) {
      const evidence = failureEvidence(error, staged ? 'finalize' : 'stage');
      if (staged) {
        await this.input.s6.rollback(staged.stagingId, context).catch(() => undefined);
      }
      await this.input.jobs
        .setStep(
          {
            jobId: plan.jobId,
            stepKey: staged ? 'switch-synonym-index' : 'stage-synonym-index',
            status: 'failed',
            idempotencyKey: `s9-fail:${plan.jobId}:${plan.candidateFileVersion}`,
            error: evidence,
            compensationState: staged ? 'required' : 'none',
          },
          context,
        )
        .catch(() => undefined);
      try {
        await this.input.repository.failRebuild(
          plan,
          {
            retryable: retryable(error),
            errorCode: problemCode(error),
            failureEvidence: evidence,
          },
          context,
        );
      } catch {
        return 'retry';
      }
      return retryable(error) ? 'retry' : 'dead_letter';
    }
  }

  async handleQueue(
    jobId: string,
    workerId: string,
    context: TenantContext,
  ): Promise<'succeeded' | 'retry' | 'dead_letter'> {
    const raw = await this.input.jobs.getRaw(jobId, context);
    if (raw.kind !== 'synonym_rebuild') {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { field: 'kind', expected: 'synonym_rebuild', actual: raw.kind },
      });
    }
    if (raw.status === 'succeeded') return 'succeeded';
    if (['failed', 'dead_letter', 'cancelled'].includes(raw.status)) return 'dead_letter';
    if (raw.status !== 'queued') return 'retry';
    const claimed = await this.input.jobs.claimById(
      { jobId, kinds: ['synonym_rebuild'], workerId },
      context,
    );
    if (!claimed) return 'retry';
    const leased = await this.input.jobs.getRaw(jobId, context);
    await this.input.jobs.start(
      jobId,
      claimed.version,
      claimed.attemptEpoch,
      String(leased.fencingToken),
      workerId,
      context,
    );
    const plan = await this.input.repository.getRebuildPlan(jobId, context);
    return this.execute(plan, context);
  }
}

export class S09RebuildQueueHandler {
  constructor(private readonly rebuild: S09RebuildApplication) {}

  handle(
    payload: { jobId: string },
    workerId: string,
    context: TenantContext,
  ): Promise<'succeeded' | 'retry' | 'dead_letter'> {
    return this.rebuild.handleQueue(payload.jobId, workerId, context);
  }
}
