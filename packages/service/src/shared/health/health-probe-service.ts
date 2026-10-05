import type { HealthResponse } from '@kb/contracts';
import type { HealthProbePort, ProbeResult } from '../../ports/capabilities';
import type { RequestContext } from '../../ports/types';

export interface DependencyProbe {
  name: string;
  required: boolean;
  check(): Promise<ProbeResult>;
}

export interface HealthSummary {
  response: HealthResponse;
  httpStatus: 200 | 503;
}

/**
 * 健康探针汇总（设计文档 6.9 / 12.2）：
 * 必需依赖失败 → 503；可选依赖失败 → degraded 并记录；探针不暴露版本、密钥、连接串与租户信息。
 */
export class HealthProbeService implements HealthProbePort {
  private readonly probes = new Map<string, DependencyProbe>();

  constructor(private readonly timeoutMs: number) {}

  register(probe: DependencyProbe): void {
    this.probes.set(probe.name, probe);
  }

  private async runProbe(probe: DependencyProbe): Promise<ProbeResult> {
    const startedAt = Date.now();
    try {
      return await Promise.race([
        probe.check(),
        new Promise<ProbeResult>((resolve) => {
          setTimeout(
            () =>
              resolve({ name: probe.name, status: 'failed', durationMs: Date.now() - startedAt }),
            this.timeoutMs,
          );
        }),
      ]);
    } catch {
      return { name: probe.name, status: 'failed', durationMs: Date.now() - startedAt };
    }
  }

  private async runByRequired(required: boolean): Promise<ProbeResult[]> {
    const selected = [...this.probes.values()].filter((probe) => probe.required === required);
    return Promise.all(selected.map((probe) => this.runProbe(probe)));
  }

  async checkRequired(_context: RequestContext): Promise<ProbeResult[]> {
    return this.runByRequired(true);
  }

  async checkOptional(_context: RequestContext): Promise<ProbeResult[]> {
    return this.runByRequired(false);
  }

  summarize(required: ProbeResult[], optional: ProbeResult[]): HealthSummary {
    const startedAt = Date.now();
    const failedRequired = required.some((check) => check.status === 'failed');
    const degraded =
      !failedRequired &&
      (optional.some((check) => check.status !== 'ok') ||
        required.some((check) => check.status === 'degraded'));
    return {
      response: {
        status: failedRequired ? 'failed' : degraded ? 'degraded' : 'ok',
        checks: [...required, ...optional],
        durationMs: Date.now() - startedAt,
      },
      httpStatus: failedRequired ? 503 : 200,
    };
  }
}

export function liveProbeResponse(): HealthResponse {
  return {
    status: 'ok',
    checks: [{ name: 'process', status: 'ok', durationMs: 0 }],
    durationMs: 0,
  };
}
