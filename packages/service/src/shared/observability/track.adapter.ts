import { Types, type Connection, type Model } from 'mongoose';
import type { RequestContext } from '../../ports/types';
import { TrackSchema, type TrackDoc } from '../persistence/schemas';

/** 设计 10.15 / 15.4：tracks 埋点适配器（仅 SaaS/扩展启用；best-effort，失败不影响业务）。 */
export interface TrackAdapterDeps {
  connection: Connection;
  enabled: boolean;
}

export class TrackAdapter {
  private readonly model: Model<TrackDoc>;
  private readonly enabled: boolean;

  constructor(deps: TrackAdapterDeps) {
    this.enabled = deps.enabled;
    this.model =
      (deps.connection.models.Track as Model<TrackDoc> | undefined) ??
      deps.connection.model<TrackDoc>('Track', TrackSchema);
  }

  async record(
    input: { event: string; data?: Record<string, unknown> | null },
    context: RequestContext,
  ): Promise<{ stored: boolean; skipped: boolean; degraded: boolean }> {
    if (!this.enabled) {
      return { stored: false, skipped: true, degraded: false };
    }
    try {
      await this.model.create({
        event: input.event,
        teamId: new Types.ObjectId(context.tenant.teamId),
        tmbId: new Types.ObjectId(context.tenant.tmbId),
        createTime: new Date(),
        data: input.data ?? null,
      });
      return { stored: true, skipped: false, degraded: false };
    } catch {
      return { stored: false, skipped: false, degraded: true };
    }
  }
}

export function createTrackAdapter(deps: TrackAdapterDeps): TrackAdapter {
  return new TrackAdapter(deps);
}
