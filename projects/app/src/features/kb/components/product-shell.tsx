import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState, type ReactNode } from 'react';
import styles from '../styles/kb.module.css';
import { Icon } from './ui';

export function ProductShell({
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
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    setNavOpen(false);
  }, [router.asPath]);

  return (
    <div className={styles.root}>
      <a className={styles.skipLink} href="#kb-main">
        跳到主要内容
      </a>
      <div className={styles.shell}>
        <aside
          className={`${styles.sidebar} ${navOpen ? styles.sidebarOpen : ''}`}
          aria-label="主导航"
        >
          <div className={styles.brand}>
            <span className={styles.brandMark} aria-hidden="true">
              <Icon name="database" size={18} />
            </span>
            <div>
              <div className={styles.brandTitle}>知识库</div>
              <div className={styles.brandMeta}>团队工作区</div>
            </div>
          </div>
          <nav className={styles.nav}>
            <Link
              href="/dataset/list"
              className={`${styles.navItem} ${
                router.pathname.startsWith('/dataset') ? styles.navItemActive : ''
              }`}
            >
              <Icon name="database" size={15} />
              知识库
            </Link>
          </nav>
          <div className={styles.sidebarFoot}>
            <div>仅知识库模块</div>
            <div className={styles.tiny}>模型目录由后续 Model &amp; AI 模块接入</div>
          </div>
        </aside>
        {navOpen ? (
          <button
            type="button"
            className={styles.navBackdrop}
            aria-label="关闭导航"
            onClick={() => setNavOpen(false)}
          />
        ) : null}
        <main className={styles.main} id="kb-main">
          <header className={styles.topbar}>
            <button
              type="button"
              className={styles.navToggle}
              aria-label="打开导航"
              onClick={() => setNavOpen(true)}
            >
              <Icon name="menu" size={18} />
            </button>
            <div className={styles.topbarTitle}>
              {breadcrumb ? <div className={styles.breadcrumb}>{breadcrumb}</div> : null}
              <h1 className={styles.pageTitle}>{title}</h1>
            </div>
            <div className={styles.topbarActions}>{actions}</div>
          </header>
          <div className={styles.content}>{children}</div>
        </main>
      </div>
    </div>
  );
}
