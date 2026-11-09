'use client';

import { ChakraProvider, extendTheme } from '@chakra-ui/react';
import { Global } from '@emotion/react';
import type { ReactNode } from 'react';
import { productTokens } from './tokens';

const theme = extendTheme({
  config: {
    initialColorMode: 'light',
    useSystemColorMode: false,
  },
  colors: {
    product: productTokens.colors,
  },
  fonts: {
    body: productTokens.font.body,
    heading: productTokens.font.body,
    mono: 'SFMono-Regular, Consolas, "Liberation Mono", monospace',
  },
  radii: {
    product: productTokens.radius.control,
  },
  styles: {
    global: {
      'html, body, #__next': {
        minHeight: '100%',
      },
      html: {
        fontSize: '16px',
        background: productTokens.colors.canvas,
      },
      body: {
        margin: 0,
        color: productTokens.colors.ink,
        background: productTokens.colors.canvas,
        fontFamily: productTokens.font.body,
        fontSize: '14px',
        lineHeight: 1.5,
      },
      '*, *::before, *::after': {
        boxSizing: 'border-box',
      },
      '::selection': {
        color: productTokens.colors.surface,
        background: productTokens.colors.primary,
      },
      'button, input, select, textarea': {
        font: 'inherit',
      },
      'button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible':
        {
          outline: 'none',
          boxShadow: productTokens.shadows.focus,
        },
    },
  },
  components: {
    Button: {
      baseStyle: {
        borderRadius: '6px',
        fontWeight: '500',
        letterSpacing: 0,
      },
    },
    Heading: {
      baseStyle: {
        letterSpacing: 0,
      },
    },
  },
});

const globalStyles = {
  ':root': {
    '--kb2-primary': productTokens.colors.primary,
    '--kb2-primary-hover': productTokens.colors.primaryHover,
    '--kb2-primary-pressed': productTokens.colors.primaryPressed,
    '--kb2-primary-tint': productTokens.colors.primaryTint,
    '--kb2-primary-subtle': productTokens.colors.primarySubtle,
    '--kb2-canvas': productTokens.colors.canvas,
    '--kb2-page': productTokens.colors.page,
    '--kb2-surface': productTokens.colors.surface,
    '--kb2-surface-muted': productTokens.colors.surfaceMuted,
    '--kb2-line-soft': productTokens.colors.lineSoft,
    '--kb2-line': productTokens.colors.line,
    '--kb2-line-strong': productTokens.colors.lineStrong,
    '--kb2-ink': productTokens.colors.ink,
    '--kb2-text': productTokens.colors.text,
    '--kb2-muted': productTokens.colors.muted,
    '--kb2-disabled': productTokens.colors.disabled,
    '--kb2-success-bg': productTokens.colors.successBg,
    '--kb2-success-border': productTokens.colors.successBorder,
    '--kb2-success': productTokens.colors.success,
    '--kb2-warning-bg': productTokens.colors.warningBg,
    '--kb2-warning-border': productTokens.colors.warningBorder,
    '--kb2-warning': productTokens.colors.warning,
    '--kb2-danger-bg': productTokens.colors.dangerBg,
    '--kb2-danger-border': productTokens.colors.dangerBorder,
    '--kb2-danger': productTokens.colors.danger,
    '--kb2-info-bg': productTokens.colors.infoBg,
    '--kb2-info-border': productTokens.colors.infoBorder,
    '--kb2-info': productTokens.colors.info,
    '--kb2-purple-bg': productTokens.colors.purpleBg,
    '--kb2-purple-border': productTokens.colors.purpleBorder,
    '--kb2-purple': productTokens.colors.purple,
    '--kb2-radius-control': productTokens.radius.control,
    '--kb2-radius-panel': productTokens.radius.panel,
    '--kb2-radius-card': productTokens.radius.card,
    '--kb2-radius-page': productTokens.radius.page,
    '--kb2-shadow-button': productTokens.shadows.button,
    '--kb2-shadow-card': productTokens.shadows.card,
    '--kb2-shadow-menu': productTokens.shadows.menu,
    '--kb2-shadow-modal': productTokens.shadows.modal,
  },
};

export function FastGptProductProvider(props: { children: ReactNode }) {
  return (
    <ChakraProvider theme={theme} resetCSS>
      <Global styles={globalStyles} />
      {props.children}
    </ChakraProvider>
  );
}
