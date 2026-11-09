'use client';

import { CopyIcon } from '@chakra-ui/icons';
import type { ReactNode } from 'react';

export function ProductAppShell(props: {
  children: ReactNode;
  active?: 'knowledge';
  title?: string;
}) {
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
        </nav>
        <div className="kb2-rail__footer" aria-hidden="true">
          <span>KB</span>
        </div>
      </aside>
      <div className="kb2-shell__body">
        <header className="kb2-mobile-header">
          <a href="/dataset/list">知识库</a>
          <span>{props.title ?? '知识库'}</span>
        </header>
        <main id="kb2-main" tabIndex={-1} className="kb2-shell__main">
          {props.children}
        </main>
      </div>
    </div>
  );
}
