import '@kb/web/styles/knowledge.css';
import {
  KnowledgeAppShell,
  KnowledgeI18nProvider,
  KnowledgeQueryProvider,
  KnowledgeUiProvider,
  type ShellLocation,
} from '@kb/web';
import type { AppProps } from 'next/app';
import { useRouter } from 'next/router';

export default function App({ Component, pageProps }: AppProps) {
  const router = useRouter();
  const location: ShellLocation = {
    pathname: router.pathname,
    query: router.query,
  };
  return (
    <KnowledgeI18nProvider>
      <KnowledgeUiProvider>
        <KnowledgeQueryProvider>
          <KnowledgeAppShell location={location}>
            <Component {...pageProps} />
          </KnowledgeAppShell>
        </KnowledgeQueryProvider>
      </KnowledgeUiProvider>
    </KnowledgeI18nProvider>
  );
}
