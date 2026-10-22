'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { ensureConsoleSession, type ConsoleSession } from '../client/knowledge-client';

export interface ShellLocation {
  pathname: string;
  query: Record<string, string | string[] | undefined>;
}

function queryString(
  query: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const value = query[key];
  return Array.isArray(value) ? value[0] : value;
}

export function KnowledgeAppShell(props: { location: ShellLocation; children: ReactNode }) {
  const [session, setSession] = useState<ConsoleSession | null>(null);
  const [sessionError, setSessionError] = useState(false);
  const spaceId = queryString(props.location.query, 'spaceId');

  useEffect(() => {
    let active = true;
    void ensureConsoleSession()
      .then((value) => {
        if (active) setSession(value);
      })
      .catch(() => {
        if (active) setSessionError(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const spaceLinks = spaceId
    ? [
        ['01', 'Overview', `/spaces/${spaceId}/overview`],
        ['02', 'Sources', `/spaces/${spaceId}/sources`],
        ['03', 'Segments', `/spaces/${spaceId}/segments`],
        ['04', 'Tags', `/spaces/${spaceId}/tags`],
        ['05', 'Access', `/spaces/${spaceId}/access`],
        ['06', 'Jobs', `/spaces/${spaceId}/jobs`],
      ]
    : [];

  return (
    <div className="console-shell">
      <a className="skip-link" href="#knowledge-main">
        Skip to content
      </a>
      <aside className="console-rail" aria-label="Primary navigation">
        <a className="wordmark" href="/spaces">
          <span className="wordmark-mark">K</span>
          <span>
            <strong>Knowledge</strong>
            <small>Architecture baseline</small>
          </span>
        </a>

        <nav className="rail-nav">
          <div className="nav-group">
            <p className="nav-label">Workspace</p>
            <a
              className={
                props.location.pathname.startsWith('/spaces') ? 'nav-item active' : 'nav-item'
              }
              href="/spaces"
            >
              <span className="folio">00</span>
              Spaces
            </a>
            <a
              className={
                props.location.pathname === '/system/status' ? 'nav-item active' : 'nav-item'
              }
              href="/system/status"
            >
              <span className="folio">SYS</span>
              System status
            </a>
          </div>

          {spaceLinks.length > 0 ? (
            <div className="nav-group">
              <p className="nav-label">Current space</p>
              {spaceLinks.map(([folio, label, href]) => (
                <a
                  key={href}
                  className={props.location.pathname === href ? 'nav-item active' : 'nav-item'}
                  href={href}
                >
                  <span className="folio">{folio}</span>
                  {label}
                </a>
              ))}
            </div>
          ) : null}
        </nav>

        <div className="rail-footer">
          <span className="rail-rule" />
          <p>
            {session
              ? session.workspaceId
              : sessionError
                ? 'Session unavailable'
                : 'Resolving workspace...'}
          </p>
          <small>API /v1/knowledge</small>
        </div>
      </aside>

      <div className="console-main">
        <header className="context-bar">
          <div>
            <span>Knowledge workspace</span>
            <strong>{session?.workspaceId ?? 'No active workspace'}</strong>
          </div>
          <div className="context-meta">
            <span>{session?.isWorkspaceOwner ? 'Workspace owner' : 'Workspace member'}</span>
            <span>Runtime subset</span>
          </div>
        </header>
        <main id="knowledge-main" className="console-content" tabIndex={-1}>
          {props.children}
        </main>
      </div>
    </div>
  );
}
