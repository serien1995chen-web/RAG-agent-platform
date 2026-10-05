/**
 * @kb/web — 共享前端组件、hooks、i18n 与主题令牌（CR-REF-04）。
 * 显式导出面，禁止 export *；组件与主题均为自研。
 */
export const PACKAGE_NAME = '@kb/web' as const;

export { DataTable, ErrorBanner, LoadingState, PageHeader } from './components';
export type { Column, ErrorLike } from './components';
export { DEFAULT_LOCALE, MESSAGES, translate } from './i18n';
export type { Locale } from './i18n';
export { fetchApi, useRequest } from './hooks/use-request';
export type { ApiEnvelope, UseRequestResult } from './hooks/use-request';
export { tokens } from './styles/tokens';
