'use client';

import { ChakraProvider } from '@chakra-ui/react';
import { Global } from '@emotion/react';
import type { ReactNode } from 'react';
import { knowledgeGlobalStyles, knowledgeTheme } from './knowledge-theme';

export function KnowledgeUiProvider(props: { children: ReactNode }) {
  return (
    <ChakraProvider theme={knowledgeTheme} resetCSS>
      <Global styles={knowledgeGlobalStyles} />
      {props.children}
    </ChakraProvider>
  );
}
