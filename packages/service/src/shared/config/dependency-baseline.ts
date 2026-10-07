import { ApiErrorException, createApiError } from '@kb/contracts';
import { z } from 'zod';
import { ConfigValidationException } from './config-error';
import type { VersionCheckPolicy } from './system-config.schema';

/** 设计文档 6.1 / 6.3 冻结的依赖基线（Plan：kb-baseline-6.1）。 */
export const DEPENDENCY_BASELINE_ID = 'kb-baseline-6.1';

export type BaselineDependency = 'mongo' | 'redis' | 'pgvector' | 'object-store';

export interface DependencyBaselineEntry {
  dependency: BaselineDependency;
  version: string;
}

export const DEPENDENCY_BASELINE: readonly DependencyBaselineEntry[] = [
  { dependency: 'mongo', version: '5.0.32' },
  { dependency: 'redis', version: '7.2-alpine' },
  { dependency: 'pgvector', version: '0.8.0-pg15' },
  { dependency: 'object-store', version: 'RELEASE.2025-09-07T16-13-09Z' },
];

export function baselineVersionOf(dependency: BaselineDependency): string {
  const entry = DEPENDENCY_BASELINE.find((item) => item.dependency === dependency);
  if (!entry) throw new ConfigValidationException([`依赖基线缺少 ${dependency}`]);
  return entry.version;
}

/** 设计文档 3.8.1 ExternalDependencyConfig 的 dependency 集合（mock/real 按依赖）。 */
export type MockedDependency = 'auth' | 'model' | 'capacity' | 'pdfProvider' | 'backup';

export const MOCKED_DEPENDENCIES: readonly MockedDependency[] = [
  'auth',
  'model',
  'capacity',
  'pdfProvider',
  'backup',
];

const MockModeSchema = z.enum(['mock', 'real']);

export const ExternalMockModeSchema = z.object({
  auth: MockModeSchema.default('mock'),
  model: MockModeSchema.default('mock'),
  capacity: MockModeSchema.default('mock'),
  pdfProvider: MockModeSchema.default('mock'),
  backup: MockModeSchema.default('mock'),
});

export type ExternalMockModeConfig = z.infer<typeof ExternalMockModeSchema>;

export const DEFAULT_EXTERNAL_MOCK_MODE: ExternalMockModeConfig = {
  auth: 'mock',
  model: 'mock',
  capacity: 'mock',
  pdfProvider: 'mock',
  backup: 'mock',
};

/** versionCheckPolicy=offline 仅允许联调环境（设计文档 6.6）。 */
export const VERSION_CHECK_WHITELIST_ENVIRONMENTS = ['development', 'test'] as const;

export function assertKnownDependencyBaseline(baselineId: string): void {
  if (baselineId !== DEPENDENCY_BASELINE_ID) {
    throw new ConfigValidationException([`KB_DEPENDENCY_BASELINE_ID 未知基线：${baselineId}`]);
  }
}

export function assertAllowRuntimeOverride(
  allowRuntimeOverride: boolean,
  environment: string,
): void {
  if (allowRuntimeOverride && environment === 'production') {
    throw new ConfigValidationException(['KB_ALLOW_RUNTIME_OVERRIDE 生产环境非法']);
  }
}

export function assertVersionCheckPolicyAllowed(
  policy: VersionCheckPolicy,
  environment: string,
): void {
  const whitelisted = (VERSION_CHECK_WHITELIST_ENVIRONMENTS as readonly string[]).includes(
    environment,
  );
  if (policy === 'offline' && !whitelisted) {
    throw new ConfigValidationException(['KB_VERSION_CHECK_POLICY=offline 仅允许开发/测试环境']);
  }
}

export type VersionVerdict = 'ok' | 'degraded' | 'reject';

function versionPrefix(expected: string): string | null {
  const match = /^(\d+(?:\.\d+)*)/.exec(expected);
  return match?.[1] ?? null;
}

/**
 * 版本匹配：基线里的镜像 tag（如 7.2-alpine）按数字前缀匹配服务端版本（如 7.2.4）；
 * 纯数字基线要求 patch 级一致；无数字前缀（MinIO RELEASE tag）要求包含关系。
 */
export function versionMatches(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  const prefix = versionPrefix(expected);
  if (prefix === null) return actual.includes(expected);
  return actual === prefix || actual.startsWith(`${prefix}.`) || actual.startsWith(`${prefix}-`);
}

/** strict 不兼容 → reject（必需依赖按策略拒绝就绪）；degraded/offline → degraded。 */
export function judgeDependencyVersion(
  actual: string | null,
  expected: string,
  policy: VersionCheckPolicy,
): VersionVerdict {
  if (actual !== null && versionMatches(actual, expected)) return 'ok';
  return policy === 'strict' ? 'reject' : 'degraded';
}

/** 生产流量命中 mock 模式 → 501063（参数 dependency + environment），不新增错误码。 */
export function assertMockModeAllowed(input: {
  dependency: MockedDependency;
  mode: 'mock' | 'real';
  environment: string;
  requestId: string;
}): void {
  if (input.environment === 'production' && input.mode === 'mock') {
    throw new ApiErrorException(
      createApiError({
        code: 501063,
        requestId: input.requestId,
        params: { dependency: input.dependency, environment: input.environment },
      }),
    );
  }
}
