/**
 * shared/observability 统一导出入口。
 * 设计映射：9.15（观测装配）/ 10.15（审计与计量集合）/ 15.4（Audit 权威记录）。
 */
export { AuditAdapter, createAuditAdapter } from './audit.adapter';
export type { AuditAdapterDeps } from './audit.adapter';
export { UsageAdapter, createUsageAdapter } from './usage.adapter';
export type { UsageAdapterDeps } from './usage.adapter';
export { TrackAdapter, createTrackAdapter } from './track.adapter';
export type { TrackAdapterDeps } from './track.adapter';
