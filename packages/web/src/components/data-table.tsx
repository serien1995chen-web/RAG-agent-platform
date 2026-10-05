import type { CSSProperties, ReactNode } from 'react';
import { translate } from '../i18n';
import { tokens } from '../styles/tokens';

export interface Column<T> {
  key: string;
  title: string;
  render: (row: T) => ReactNode;
}

const cellStyle: CSSProperties = {
  padding: `${tokens.spacing.sm} ${tokens.spacing.md}`,
  borderBottom: `1px solid ${tokens.color.border}`,
  textAlign: 'left',
  fontSize: tokens.font.sizeMd,
};

export function DataTable<T>({
  columns,
  rows,
  rowKey,
}: {
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
}) {
  if (rows.length === 0) {
    return (
      <div style={{ color: tokens.color.textMuted, padding: tokens.spacing.md }}>
        {translate('common.empty')}
      </div>
    );
  }
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', background: tokens.color.surface }}>
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column.key} style={{ ...cellStyle, color: tokens.color.textMuted }}>
              {column.title}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={rowKey(row)}>
            {columns.map((column) => (
              <td key={column.key} style={cellStyle}>
                {column.render(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
