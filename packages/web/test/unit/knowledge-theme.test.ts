import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { knowledgeGlobalStyles, knowledgeTheme, knowledgeThemeTokens } from '../../src/theme';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');

describe('knowledge theme tokens', () => {
  it('freezes exactly 37 design tokens', () => {
    expect(Object.keys(knowledgeThemeTokens.colors)).toHaveLength(14);
    expect(Object.keys(knowledgeThemeTokens.radii)).toHaveLength(3);
    expect(Object.keys(knowledgeThemeTokens.space)).toHaveLength(7);
    expect(Object.keys(knowledgeThemeTokens.shadows)).toHaveLength(2);
    expect(Object.keys(knowledgeThemeTokens.motion)).toHaveLength(3);
    expect(Object.keys(knowledgeThemeTokens.fonts)).toHaveLength(2);
    expect(Object.keys(knowledgeThemeTokens.typography)).toHaveLength(6);
    expect(
      Object.keys(knowledgeThemeTokens.colors).length +
        Object.keys(knowledgeThemeTokens.radii).length +
        Object.keys(knowledgeThemeTokens.space).length +
        Object.keys(knowledgeThemeTokens.shadows).length +
        Object.keys(knowledgeThemeTokens.motion).length +
        Object.keys(knowledgeThemeTokens.fonts).length +
        Object.keys(knowledgeThemeTokens.typography).length,
    ).toBe(37);
  });

  it('uses the exact design values', () => {
    expect(knowledgeThemeTokens.colors).toEqual({
      canvas: '#F3F6F4',
      surface: '#FFFFFF',
      surfaceMuted: '#E8EFEC',
      ink: '#17232B',
      inkMuted: '#52636B',
      line: '#CBD8D2',
      primary: '#176B73',
      primaryHover: '#11565D',
      secondary: '#667B3F',
      accent: '#C4623B',
      warning: '#A56A12',
      danger: '#B33A3A',
      info: '#356AA0',
      focus: '#0A84A5',
    });
    expect(knowledgeThemeTokens.radii).toEqual({ sm: '4px', md: '6px', lg: '8px' });
    expect(knowledgeThemeTokens.space).toEqual({
      1: '4px',
      2: '8px',
      3: '12px',
      4: '16px',
      6: '24px',
      8: '32px',
      12: '48px',
    });
    expect(knowledgeThemeTokens.shadows[1]).toBe('0 1px 2px rgba(23,35,43,0.08)');
    expect(knowledgeThemeTokens.shadows[2]).toBe('0 8px 24px rgba(23,35,43,0.12)');
    expect(knowledgeThemeTokens.motion).toEqual({
      fast: '120ms',
      base: '180ms',
      slow: '240ms',
    });
    expect(knowledgeThemeTokens.fonts.body).toBe('IBM Plex Sans, Noto Sans SC, sans-serif');
    expect(knowledgeThemeTokens.fonts.display).toBe('Noto Serif SC, serif');
    expect(knowledgeThemeTokens.typography).toEqual({
      xs: { fontSize: '12px', lineHeight: '18px' },
      sm: { fontSize: '14px', lineHeight: '22px' },
      md: { fontSize: '16px', lineHeight: '26px' },
      lg: { fontSize: '20px', lineHeight: '30px' },
      xl: { fontSize: '24px', lineHeight: '34px' },
      '2xl': { fontSize: '32px', lineHeight: '42px' },
    });
  });

  it('feeds the Chakra theme and global CSS variables from the same token source', () => {
    expect(knowledgeTheme.colors.kn).toEqual(knowledgeThemeTokens.colors);
    expect(knowledgeTheme.fonts.body).toBe(knowledgeThemeTokens.fonts.body);
    expect(knowledgeTheme.fonts.heading).toBe(knowledgeThemeTokens.fonts.display);
    const root = knowledgeGlobalStyles[':root'];
    expect(root['--kn-canvas']).toBe(knowledgeThemeTokens.colors.canvas);
    expect(root['--kn-primary']).toBe(knowledgeThemeTokens.colors.primary);
    expect(root['--kn-space-12']).toBe(knowledgeThemeTokens.space[12]);
    expect(root['--kn-motion-slow']).toBe(knowledgeThemeTokens.motion.slow);

    const css = readFileSync(
      resolve(repositoryRoot, 'packages/web/src/styles/knowledge.css'),
      'utf8',
    );
    expect(css).not.toContain(':root');
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    expect(css).not.toContain('rgba(');
  });

  it('uses exactly one KnowledgeUiProvider and no direct ChakraProvider in _app', () => {
    const app = readFileSync(resolve(repositoryRoot, 'projects/app/src/pages/_app.tsx'), 'utf8');
    expect(app.match(/<KnowledgeUiProvider\b/g)).toHaveLength(1);
    expect(app.match(/<ChakraProvider\b/g)).toBeNull();
  });
});
