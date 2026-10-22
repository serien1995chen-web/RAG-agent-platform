import '@kb/web/styles/knowledge.css';
import { KnowledgeAppShell, type ShellLocation } from '@kb/web';
import type { AppProps } from 'next/app';
import { useRouter } from 'next/router';

export default function App({ Component, pageProps }: AppProps) {
  const router = useRouter();
  const location: ShellLocation = {
    pathname: router.pathname,
    query: router.query,
  };
  return (
    <KnowledgeAppShell location={location}>
      <Component {...pageProps} />
    </KnowledgeAppShell>
  );
}
