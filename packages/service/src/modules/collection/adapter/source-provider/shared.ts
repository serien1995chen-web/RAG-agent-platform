/**
 * P4-04 来源 Provider 公共工具（设计 8.1.1）。
 * 审计只记录 urlHash / host / 结果分类，不记录完整查询串与正文。
 */
import { createHash } from 'node:crypto';
import { ApiErrorException, createApiError } from '@kb/contracts';

export function hashSourceText(text: string): string {
  return 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex');
}

export function hashUrl(url: string): string {
  return 'sha256:' + createHash('sha256').update(url, 'utf8').digest('hex');
}

export function sourceError(
  code: number,
  requestId: string,
  params: Record<string, unknown> = {},
): ApiErrorException {
  return new ApiErrorException(createApiError({ code, requestId, params }));
}

export interface SourceReadAudit {
  event: 'source.read' | 'source.blocked' | 'source.retry' | 'source.failed';
  urlHash?: string;
  host?: string;
  outcome: string;
}

export type SourceAuditSink = (entry: SourceReadAudit) => void;
