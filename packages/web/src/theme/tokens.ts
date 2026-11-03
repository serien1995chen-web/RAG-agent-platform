export const knowledgeThemeTokens = {
  colors: {
    canvas: '#F5F7F6',
    surface: '#FFFFFF',
    surfaceMuted: '#E9EFEC',
    ink: '#14272B',
    inkMuted: '#5A6A70',
    line: '#D1DDD7',
    primary: '#176B73',
    primaryHover: '#0F565D',
    secondary: '#4F7248',
    accent: '#C1683F',
    warning: '#A26912',
    danger: '#B33A3A',
    info: '#356AA0',
    focus: '#0A84A5',
  },
  radii: {
    sm: '4px',
    md: '6px',
    lg: '8px',
  },
  space: {
    1: '4px',
    2: '8px',
    3: '12px',
    4: '16px',
    6: '24px',
    8: '32px',
    12: '48px',
  },
  shadows: {
    1: '0 1px 2px rgba(20,39,43,0.08)',
    2: '0 16px 40px rgba(20,39,43,0.16)',
  },
  motion: {
    fast: '120ms',
    base: '180ms',
    slow: '240ms',
  },
  fonts: {
    body: 'IBM Plex Sans, Noto Sans SC, system-ui, sans-serif',
    display: 'IBM Plex Sans, Noto Sans SC, system-ui, sans-serif',
  },
  typography: {
    xs: { fontSize: '12px', lineHeight: '18px' },
    sm: { fontSize: '14px', lineHeight: '22px' },
    md: { fontSize: '16px', lineHeight: '26px' },
    lg: { fontSize: '20px', lineHeight: '30px' },
    xl: { fontSize: '24px', lineHeight: '34px' },
    '2xl': { fontSize: '32px', lineHeight: '42px' },
  },
} as const;

export type KnowledgeThemeTokens = typeof knowledgeThemeTokens;
