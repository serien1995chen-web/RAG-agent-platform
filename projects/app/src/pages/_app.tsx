import '@kb/web/styles/fastgpt-product.css';
import { FastGptProductProvider, KnowledgeQueryProvider } from '@kb/web';
import type { AppProps } from 'next/app';

export default function App({ Component, pageProps }: AppProps) {
  return (
    <FastGptProductProvider>
      <KnowledgeQueryProvider>
        <Component {...pageProps} />
      </KnowledgeQueryProvider>
    </FastGptProductProvider>
  );
}
