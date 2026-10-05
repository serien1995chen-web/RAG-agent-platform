import catalogData from './error-catalog.data.json';
import type { Retryability, Severity } from '../common/api-response';

export interface ErrorCatalogEntry {
  code: number;
  messageKey: string;
  httpStatus: number;
  retryable: Retryability;
  severity: Severity;
  description: string;
  params: readonly string[];
  paramsSchema: string;
}

/** 设计文档 12.4 / 12.4.1 / 12.4.2：501001-501071 唯一业务权威。 */
export const ERROR_CATALOG: readonly ErrorCatalogEntry[] =
  catalogData.errors as unknown as readonly ErrorCatalogEntry[];

export const ERROR_CATALOG_BY_CODE: ReadonlyMap<number, ErrorCatalogEntry> = new Map(
  ERROR_CATALOG.map((entry) => [entry.code, entry]),
);

/**
 * 骨架期占位错误码（SKEL-ADR-007）。
 * 不属于 501001-501071 业务矩阵，仅用于尚未实现的路由与 Port。
 */
export const SKELETON_NOT_IMPLEMENTED = 501999 as const;

/** 骨架期未知内部错误（HTTP 500）；不属于 501001-501071 业务矩阵。 */
export const SKELETON_INTERNAL_ERROR = 501998 as const;

export const SKELETON_NOT_IMPLEMENTED_META: ErrorCatalogEntry = {
  code: SKELETON_NOT_IMPLEMENTED,
  messageKey: 'skeleton.not_implemented',
  httpStatus: 501,
  retryable: 'no-retry',
  severity: 'warning',
  description: '骨架期尚未实现的稳定占位错误；实现完成后必须移除。',
  params: ['route', 'port', 'operation'],
  paramsSchema: '{route|port|operation}',
};

export const SKELETON_INTERNAL_ERROR_META: ErrorCatalogEntry = {
  code: SKELETON_INTERNAL_ERROR,
  messageKey: 'skeleton.internal_error',
  httpStatus: 500,
  retryable: 'manual',
  severity: 'fatal',
  description: '骨架期未映射的内部错误；不得暴露原始堆栈或敏感信息。',
  params: ['operation'],
  paramsSchema: '{operation}',
};

export function getErrorMeta(code: number): ErrorCatalogEntry | undefined {
  if (code === SKELETON_NOT_IMPLEMENTED) return SKELETON_NOT_IMPLEMENTED_META;
  if (code === SKELETON_INTERNAL_ERROR) return SKELETON_INTERNAL_ERROR_META;
  return ERROR_CATALOG_BY_CODE.get(code);
}
