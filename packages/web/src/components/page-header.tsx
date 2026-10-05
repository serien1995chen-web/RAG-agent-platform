import type { ReactNode } from 'react';
import { tokens } from '../styles/tokens';

export function PageHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: tokens.spacing.md,
        marginBottom: tokens.spacing.lg,
      }}
    >
      <h1 style={{ margin: 0, fontSize: tokens.font.sizeXl, color: tokens.color.text }}>{title}</h1>
      {actions}
    </header>
  );
}
