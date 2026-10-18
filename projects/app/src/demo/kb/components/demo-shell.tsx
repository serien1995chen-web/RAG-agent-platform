import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState, type ReactNode } from 'react';
import { demoFetch } from '../lib/demo-fetch';
import { useOnce } from '../lib/use-once';
import { useDemoStore } from '../lib/use-demo-store';
import styles from '../styles/demo.module.css';
import { Glyph } from './primitives';
import { RunSpine } from './run-spine';

const NAV = [
  { href: '/demo/kb', label: '概览', glyph: 'overview' as const },
  { href: '/demo/kb/datasets', label: '知识库', glyph: 'datasets' as const },
  { href: '/demo/kb/runs', label: '验收场景', glyph: 'runs' as const },
  { href: '/demo/kb/coverage', label: 'API 覆盖', glyph: 'coverage' as const },
  { href: '/demo/kb/defects', label: '缺陷记录', glyph: 'defects' as const },
  { href: '/demo/kb/runtime', label: '运行环境', glyph: 'runtime' as const },
];

const BASELINE_COMMIT = process.env.NEXT_PUBLIC_DEMO_BASELINE_COMMIT ?? 'unknown';
const BASELINE_BRANCH = process.env.NEXT_PUBLIC_DEMO_BASELINE_BRANCH ?? 'unknown';

function download(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function DemoShell({
  title,
  breadcrumb,
  actions,
  children,
}: {
  title: string;
  breadcrumb?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const router = useRouter();
  const { runs, defects, scenarios } = useDemoStore();
  const [navOpen, setNavOpen] = useState(false);
  const [health, setHealth] = useState<'unknown' | 'ok' | 'failed'>('unknown');

  useOnce(() => {
    void demoFetch<{ status: string }>({ method: 'GET', path: '/api/readyz' }).then((result) => {
      setHealth(result.ok && result.envelope.data?.status === 'ok' ? 'ok' : 'failed');
    });
  });

  const exportSession = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      baseline: { branch: BASELINE_BRANCH, commit: BASELINE_COMMIT },
      runs,
      defects,
      scenarios,
    };
    download(
      `kb-demo-session-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`,
      JSON.stringify(payload, null, 2),
      'application/json',
    );
  };

  return (
    <div className={styles.root}>
      <Head>
        <title>{title} · 知识库验收平台</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      <div className={styles.shell}>
        <aside className={`${styles.sidebar} ${navOpen ? styles.sidebarOpen : ''}`} aria-label="主导航">
          <div className={styles.brand}>
            <div className={styles.brandTitle}>知识库验收平台</div>
            <div className={styles.brandSub}>
              {BASELINE_BRANCH}@{BASELINE_COMMIT.slice(0, 7)}
            </div>
          </div>
          <nav className={styles.nav}>
            {NAV.map((item) => {
              const active =
                item.href === '/demo/kb'
                  ? router.pathname === '/demo/kb'
                  : router.pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`${styles.navItem} ${active ? styles.navItemActive : ''}`}
                  onClick={() => setNavOpen(false)}
                >
                  <Glyph name={item.glyph} />
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className={styles.sidebarFoot}>
            调用 {runs.length} · 缺陷 {defects.length}
            <div className={styles.tiny}>仅知识库模块</div>
          </div>
        </aside>

        <main className={styles.main}>
          <div className={styles.topbar}>
            <button
              type="button"
              className={`${styles.button} ${styles.buttonSmall} ${styles.navToggle}`}
              onClick={() => setNavOpen((open) => !open)}
              aria-label="切换导航"
            >
              导航
            </button>
            <div>
              <h1 className={styles.pageTitle}>{title}</h1>
              {breadcrumb ? <div className={styles.crumb}>{breadcrumb}</div> : null}
            </div>
            <span className={styles.topSpacer} />
            <div className={styles.topMeta}>
              <span className={styles.healthDot} title="readyz 探针">
                <span
                  className={`${styles.dot} ${
                    health === 'ok' ? styles.dotOk : health === 'failed' ? styles.dotErr : ''
                  }`}
                  aria-hidden="true"
                />
                {health === 'ok' ? '健康' : health === 'failed' ? '异常' : '检测中'}
              </span>
              <span className={styles.mono}>{BASELINE_COMMIT.slice(0, 7)}</span>
              <Link className={styles.button} href="/demo/kb/datasets?create=1">
                新建知识库
              </Link>
              <button type="button" className={styles.button} onClick={exportSession}>
                导出记录
              </button>
              {actions}
            </div>
          </div>
          {children}
        </main>

        <RunSpine />
      </div>
    </div>
  );
}
