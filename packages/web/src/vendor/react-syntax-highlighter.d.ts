declare module 'react-syntax-highlighter/dist/esm/prism' {
  import type { ComponentType, CSSProperties, ElementType } from 'react';

  interface SyntaxHighlighterProps {
    language?: string;
    style?: Record<string, CSSProperties>;
    children: string;
    PreTag?: ElementType;
    customStyle?: CSSProperties;
    [key: string]: unknown;
  }

  const SyntaxHighlighter: ComponentType<SyntaxHighlighterProps>;
  export default SyntaxHighlighter;
}

declare module 'react-syntax-highlighter/dist/esm/styles/prism' {
  import type { CSSProperties } from 'react';

  export const vs: Record<string, CSSProperties>;
}
