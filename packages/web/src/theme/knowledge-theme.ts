import { extendTheme, type ThemeConfig } from '@chakra-ui/react';
import { knowledgeThemeTokens } from './tokens';

const config: ThemeConfig = {
  initialColorMode: 'light',
  useSystemColorMode: false,
};

const fontSizes = Object.fromEntries(
  Object.entries(knowledgeThemeTokens.typography).map(([key, value]) => [key, value.fontSize]),
);
const lineHeights = Object.fromEntries(
  Object.entries(knowledgeThemeTokens.typography).map(([key, value]) => [key, value.lineHeight]),
);

export const knowledgeTheme = extendTheme({
  config,
  colors: {
    kn: knowledgeThemeTokens.colors,
  },
  radii: knowledgeThemeTokens.radii,
  space: knowledgeThemeTokens.space,
  shadows: {
    kn1: knowledgeThemeTokens.shadows[1],
    kn2: knowledgeThemeTokens.shadows[2],
  },
  fonts: {
    body: knowledgeThemeTokens.fonts.body,
    heading: knowledgeThemeTokens.fonts.display,
    mono: 'SFMono-Regular, Consolas, Liberation Mono, monospace',
  },
  fontSizes,
  lineHeights,
  styles: {
    global: {
      'html, body, #__next': {
        minHeight: '100%',
      },
      body: {
        margin: 0,
        color: 'kn.ink',
        backgroundColor: 'kn.canvas',
        fontFamily: 'body',
        fontSize: 'sm',
      },
      '*, *::before, *::after': {
        boxSizing: 'border-box',
      },
      'a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible':
        {
          outline: `2px solid ${knowledgeThemeTokens.colors.focus}`,
          outlineOffset: '2px',
        },
    },
  },
  components: {
    Button: {
      baseStyle: {
        borderRadius: 'sm',
        fontWeight: '700',
      },
    },
    Input: {
      variants: {
        outline: {
          field: {
            borderColor: 'kn.line',
            borderRadius: 'sm',
            backgroundColor: 'kn.surface',
            _hover: { borderColor: 'kn.inkMuted' },
            _focusVisible: {
              borderColor: 'kn.focus',
              boxShadow: `0 0 0 1px ${knowledgeThemeTokens.colors.focus}`,
            },
          },
        },
      },
      defaultProps: { variant: 'outline' },
    },
    Select: {
      variants: {
        outline: {
          field: {
            borderColor: 'kn.line',
            borderRadius: 'sm',
            backgroundColor: 'kn.surface',
            _hover: { borderColor: 'kn.inkMuted' },
            _focusVisible: {
              borderColor: 'kn.focus',
              boxShadow: `0 0 0 1px ${knowledgeThemeTokens.colors.focus}`,
            },
          },
        },
      },
      defaultProps: { variant: 'outline' },
    },
    Textarea: {
      variants: {
        outline: {
          borderColor: 'kn.line',
          borderRadius: 'sm',
          backgroundColor: 'kn.surface',
          _hover: { borderColor: 'kn.inkMuted' },
          _focusVisible: {
            borderColor: 'kn.focus',
            boxShadow: `0 0 0 1px ${knowledgeThemeTokens.colors.focus}`,
          },
        },
      },
      defaultProps: { variant: 'outline' },
    },
  },
});

export const knowledgeGlobalStyles = {
  ':root': {
    '--kn-canvas': knowledgeThemeTokens.colors.canvas,
    '--kn-surface': knowledgeThemeTokens.colors.surface,
    '--kn-surface-muted': knowledgeThemeTokens.colors.surfaceMuted,
    '--kn-ink': knowledgeThemeTokens.colors.ink,
    '--kn-ink-muted': knowledgeThemeTokens.colors.inkMuted,
    '--kn-line': knowledgeThemeTokens.colors.line,
    '--kn-primary': knowledgeThemeTokens.colors.primary,
    '--kn-primary-hover': knowledgeThemeTokens.colors.primaryHover,
    '--kn-secondary': knowledgeThemeTokens.colors.secondary,
    '--kn-accent': knowledgeThemeTokens.colors.accent,
    '--kn-warning': knowledgeThemeTokens.colors.warning,
    '--kn-danger': knowledgeThemeTokens.colors.danger,
    '--kn-info': knowledgeThemeTokens.colors.info,
    '--kn-focus': knowledgeThemeTokens.colors.focus,
    '--kn-radius-sm': knowledgeThemeTokens.radii.sm,
    '--kn-radius-md': knowledgeThemeTokens.radii.md,
    '--kn-radius-lg': knowledgeThemeTokens.radii.lg,
    '--kn-space-1': knowledgeThemeTokens.space[1],
    '--kn-space-2': knowledgeThemeTokens.space[2],
    '--kn-space-3': knowledgeThemeTokens.space[3],
    '--kn-space-4': knowledgeThemeTokens.space[4],
    '--kn-space-6': knowledgeThemeTokens.space[6],
    '--kn-space-8': knowledgeThemeTokens.space[8],
    '--kn-space-12': knowledgeThemeTokens.space[12],
    '--kn-shadow-1': knowledgeThemeTokens.shadows[1],
    '--kn-shadow-2': knowledgeThemeTokens.shadows[2],
    '--kn-motion-fast': knowledgeThemeTokens.motion.fast,
    '--kn-motion-base': knowledgeThemeTokens.motion.base,
    '--kn-motion-slow': knowledgeThemeTokens.motion.slow,
    '--kn-font-body': knowledgeThemeTokens.fonts.body,
    '--kn-font-display': knowledgeThemeTokens.fonts.display,
    '--kn-text-xs': knowledgeThemeTokens.typography.xs.fontSize,
    '--kn-text-sm': knowledgeThemeTokens.typography.sm.fontSize,
    '--kn-text-md': knowledgeThemeTokens.typography.md.fontSize,
    '--kn-text-lg': knowledgeThemeTokens.typography.lg.fontSize,
    '--kn-text-xl': knowledgeThemeTokens.typography.xl.fontSize,
    '--kn-text-2xl': knowledgeThemeTokens.typography['2xl'].fontSize,
    colorScheme: 'light',
  },
  body: {
    backgroundColor: 'var(--kn-canvas)',
    color: 'var(--kn-ink)',
    fontFamily: 'var(--kn-font-body)',
    fontSize: 'var(--kn-text-sm)',
  },
};
