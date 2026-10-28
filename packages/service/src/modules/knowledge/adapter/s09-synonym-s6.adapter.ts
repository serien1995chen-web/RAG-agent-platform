import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type { SynonymRebuildPlan, SynonymStagedRebuild } from '../domain/s09-synonym-rebuild';
import type { S09S6RebuildIndexPort, S09S6RebuildPort } from '../application/s09-synonym.ports';

export class S09SynonymS6Adapter implements S09S6RebuildPort {
  constructor(private readonly index: S09S6RebuildIndexPort) {}

  async stageProfile(
    plan: SynonymRebuildPlan,
    context: TenantContext,
  ): Promise<SynonymStagedRebuild> {
    return this.index.stage({ plan, context });
  }

  async reuseOrBuildVector(
    plan: SynonymRebuildPlan,
    staged: SynonymStagedRebuild,
    context: TenantContext,
  ): Promise<SynonymStagedRebuild> {
    return this.index.reuseOrBuildVector({ plan, staged, context });
  }

  async finalize(
    plan: SynonymRebuildPlan,
    staged: SynonymStagedRebuild,
    context: TenantContext,
  ): Promise<SynonymStagedRebuild> {
    const finalized = await this.index.finalize({ plan, staged, context });
    return {
      ...staged,
      indexedSegmentVersions: finalized.indexedSegmentVersions,
      cleanupCandidates: finalized.cleanupCandidates,
    };
  }

  rollback(stagingId: string, context: TenantContext): Promise<void> {
    return this.index.rollback({ stagingId, context });
  }
}
