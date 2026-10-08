import type { HealthResponse } from '@kb/contracts';
import type { HealthProbePort, ProbeResult } from '../../ports/capabilities';
import type { RequestContext } from '../../ports/types';
import {
  baselineVersionOf,
  judgeDependencyVersion,
  type BaselineDependency,
} from '../config/dependency-baseline';
import type { VersionCheckPolicy } from '../config/system-config.schema';

export interface DependencyProbe {
  name: string;
  required: boolean;
  check(): Promise<ProbeResult>;
}

export interface VersionedProbeOptions {
  name: string;
  required: boolean;
  dependency: BaselineDependency;
  policy: VersionCheckPolicy;
  /** 只读取版本号；读取失败抛错即视为探针失败。 */
  readVersion(): Promise<string | null>;
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

  /**
   * 注册带版本判定的依赖探针（设计文档 6.6 / 6.9）：
   * 版本只用于内部判定，不进入探针响应；strict 不兼容 → failed，degraded/offline → degraded。
   */
  registerVersionedProbe(options: VersionedProbeOptions): void {
    const expected = baselineVersionOf(options.dependency);
    this.register({
      name: options.name,
      required: options.required,
      check: async () => {
        const startedAt = Date.now();
        const actual = await options.readVersion();
        const verdict = judgeDependencyVersion(actual, expected, options.policy);
        return {
          name: options.name,
          status: verdict === 'reject' ? 'failed' : verdict,
          durationMs: Date.now() - startedAt,
        };
      },
    });
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

  /** 探针响应只允许 name/status/durationMs，杜绝版本、密钥、连接串与租户信息泄漏。 */
  private sanitize(check: ProbeResult): ProbeResult {
    return { name: check.name, status: check.status, durationMs: check.durationMs };
  }

  summarize(required: ProbeResult[], optional: ProbeResult[]): HealthSummary {
    const startedAt = Date.now();
    const requiredChecks = required.map((check) => this.sanitize(check));
    const optionalChecks = optional.map((check) => this.sanitize(check));
    const failedRequired = requiredChecks.some((check) => check.status === 'failed');
    const degraded =
      !failedRequired &&
      (optionalChecks.some((check) => check.status !== 'ok') ||
        requiredChecks.some((check) => check.status === 'degraded'));
    return {
      response: {
        status: failedRequired ? 'failed' : degraded ? 'degraded' : 'ok',
        checks: [...requiredChecks, ...optionalChecks],
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
