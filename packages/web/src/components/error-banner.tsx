import type { CSSProperties } from 'react';
import { translate } from '../i18n';
import { tokens } from '../styles/tokens';

export interface ErrorLike {
  messageKey: string;
  params?: Record<string, unknown>;
  requestId?: string;
}

const style: CSSProperties = {
  border: `1px solid ${tokens.color.danger}`,
  background: '#fef2f2',
  color: tokens.color.danger,
  borderRadius: tokens.radius.md,
  padding: `${tokens.spacing.sm} ${tokens.spacing.md}`,
  fontSize: tokens.font.sizeMd,
  marginBottom: tokens.spacing.md,
};

/** 错误展示只消费 messageKey + params，不渲染后端兼容 message 文本。 */
export function ErrorBanner({ error }: { error: ErrorLike }) {
  return (
    <div role="alert" style={style}>
      {translate(error.messageKey, error.params ?? {})}
    </div>
  );
}
