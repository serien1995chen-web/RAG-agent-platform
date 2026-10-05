import { translate } from '../i18n';
import { tokens } from '../styles/tokens';

export function LoadingState({ labelKey = 'common.loading' }: { labelKey?: string }) {
  return (
    <div
      style={{
        color: tokens.color.textMuted,
        fontSize: tokens.font.sizeMd,
        padding: tokens.spacing.md,
      }}
    >
      {translate(labelKey)}
    </div>
  );
}
