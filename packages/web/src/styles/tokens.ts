/** 主题令牌（自研；不得复制来源项目主题文件）。 */
export const tokens = {
  color: {
    background: '#f7f8fa',
    surface: '#ffffff',
    border: '#e5e7eb',
    text: '#1f2937',
    textMuted: '#6b7280',
    primary: '#2563eb',
    danger: '#b91c1c',
    warning: '#b45309',
    success: '#15803d',
  },
  radius: { sm: '4px', md: '6px', lg: '8px' },
  spacing: { xs: '4px', sm: '8px', md: '16px', lg: '24px' },
  font: {
    family:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
    sizeSm: '12px',
    sizeMd: '14px',
    sizeLg: '18px',
    sizeXl: '22px',
  },
} as const;
