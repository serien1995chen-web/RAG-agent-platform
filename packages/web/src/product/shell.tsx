'use client';

import { CopyIcon, SettingsIcon } from '@chakra-ui/icons';
import { useEffect, useState, type ReactNode } from 'react';
import { ensureConsoleSession, type ConsoleSession } from '../client/knowledge-client';

export function ProductAppShell(props: {
  children: ReactNode;
  active?: 'knowledge' | 'operations';
  title?: string;
}) {
  const [session, setSession] = useState<ConsoleSession | null>(null);
  useEffect(() => {
    let active = true;
    void ensureConsoleSession()
      .then((value) => {
        if (active) setSession(value);
      })
      .catch(() => {
        if (active) setSession(null);
      });
    return () => {
      active = false;
    };
  }, []);
  const canManageOperations = session?.scopes.includes('knowledge:admin') === true;
  return (
    <div className="kb2-shell">
      <a className="kb2-skip-link" href="#kb2-main">
        跳到主要内容
      </a>
      <aside className="kb2-rail" aria-label="主导航">
        <a className="kb2-brand" href="/dataset/list" aria-label="知 知识库首页">
          <span className="kb2-brand__mark">知</span>
          <span className="kb2-brand__text">知识库</span>
        </a>
        <nav className="kb2-rail__nav">
          <a
            href="/dataset/list"
            className="kb2-rail__item"
            aria-current={props.active === 'knowledge' ? 'page' : undefined}
          >
            <CopyIcon boxSize="22px" />
            <span>知识库</span>
          </a>
          {canManageOperations ? (
            <a
              href="/settings/operations"
              className="kb2-rail__item"
              aria-current={props.active === 'operations' ? 'page' : undefined}
            >
              <SettingsIcon boxSize="22px" />
              <span>运营</span>
            </a>
          ) : null}
        </nav>
        <div className="kb2-rail__footer" aria-hidden="true">
          <span>KB</span>
        </div>
      </aside>
      <div className="kb2-shell__body">
        <header className="kb2-mobile-header">
          <a href="/dataset/list">知识库</a>
          <div className="kb2-mobile-header__links">
            {canManageOperations ? (
              <a
                href="/settings/operations"
                aria-current={props.active === 'operations' ? 'page' : undefined}
              >
                运营
              </a>
            ) : null}
            <span>{props.title ?? '知识库'}</span>
          </div>
        </header>
        <main id="kb2-main" tabIndex={-1} className="kb2-shell__main">
          {props.children}
        </main>
      </div>
    </div>
  );
}
