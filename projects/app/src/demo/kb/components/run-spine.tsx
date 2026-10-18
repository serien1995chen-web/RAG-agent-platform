import { useState } from 'react';
import { buildCurl } from '../lib/demo-fetch';
import { useDemoStore } from '../lib/use-demo-store';
import styles from '../styles/demo.module.css';
import type { RunEntry } from '../types';
import { DefectComposer } from './defect-composer';
import { HttpBadge } from './primitives';

function fmtTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

function shortPath(path: string): string {
  try {
    const url = new URL(path, 'http://demo.local');
    return url.pathname;
  } catch {
    return path;
  }
}

/** 运行脊柱：本次会话每次 API 调用的编年记录，是验收证据链的核心。 */
export function RunSpine() {
  const { runs } = useDemoStore();
  // 小屏时脊柱改为底部抽屉，默认折叠，避免遮挡主内容。
  const [collapsed, setCollapsed] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < 1024,
  );
  const [openSeq, setOpenSeq] = useState<number | null>(null);
  const [defectFor, setDefectFor] = useState<RunEntry | null>(null);

  const failures = runs.filter((run) => run.status >= 400 || run.code >= 400 || run.status === 0);

  if (collapsed) {
    return (
      <aside className={`${styles.spine} ${styles.spineCollapsed}`} aria-label="运行脊柱">
        <div className={styles.spineHead}>
          <button
            type="button"
            className={`${styles.button} ${styles.buttonSmall}`}
            onClick={() => setCollapsed(false)}
            aria-label="展开运行脊柱"
          >
            展开
          </button>
          <span className={styles.spineMeta}>
            {runs.length} 调用 / {failures.length} 失败
          </span>
        </div>
      </aside>
    );
  }

  return (
    <aside className={styles.spine} aria-label="运行脊柱">
      <div className={styles.spineHead}>
        <span className={styles.spineTitle}>运行脊柱</span>
        <span className={styles.spineMeta}>
          {runs.length} 调用 / {failures.length} 失败
        </span>
        <button
          type="button"
          className={`${styles.button} ${styles.buttonSmall}`}
          onClick={() => setCollapsed(true)}
          aria-label="折叠运行脊柱"
        >
          折叠
        </button>
      </div>
      <div className={styles.spineList}>
        {runs.length === 0 ? (
          <div className={styles.spineDetail}>
            <div className={styles.muted}>本会话还没有调用。</div>
            <div className={styles.tiny}>在页面里做一次操作，这里会出现带 requestId 的记录。</div>
          </div>
        ) : null}
        {runs.map((run) => {
          const failed = run.status >= 400 || run.code >= 400 || run.status === 0;
          const active = openSeq === run.seq;
          return (
            <div key={run.seq}>
              <button
                type="button"
                className={`${styles.spineRow} ${failed ? styles.spineRowFail : ''} ${
                  active ? styles.spineRowActive : ''
                }`}
                onClick={() => setOpenSeq(active ? null : run.seq)}
                aria-expanded={active}
              >
                <span className={styles.spineLine1}>
                  <span className={styles.spineSeq}>#{String(run.seq).padStart(3, '0')}</span>
                  <span>{fmtTime(run.at)}</span>
                  <span className={styles.spineMethod}>{run.method}</span>
                  <span className={styles.spineStatus}>
                    {run.status || 'ERR'} · {run.durationMs}ms
                  </span>
                </span>
                <span className={styles.spineLine2}>{shortPath(run.path)}</span>
              </button>
              {active ? (
                <div className={styles.spineDetail}>
                  <div className={styles.kv}>
                    <span className={styles.kvKey}>HTTP</span>
                    <span className={styles.kvVal}>
                      <HttpBadge status={run.status} code={run.code} />
                    </span>
                    <span className={styles.kvKey}>messageKey</span>
                    <span className={styles.kvVal}>{run.messageKey ?? '—'}</span>
                    <span className={styles.kvKey}>requestId</span>
                    <span className={styles.kvVal}>{run.requestId ?? '—'}</span>
                    <span className={styles.kvKey}>耗时</span>
                    <span className={styles.kvVal}>{run.durationMs}ms</span>
                  </div>
                  {run.params ? (
                    <pre className={styles.codeBlock}>{JSON.stringify(run.params, null, 2)}</pre>
                  ) : null}
                  {run.requestBody !== undefined ? (
                    <>
                      <div className={`${styles.kvKey} ${styles.mt8}`}>请求体</div>
                      <pre className={styles.codeBlock}>
                        {JSON.stringify(run.requestBody, null, 2)}
                      </pre>
                    </>
                  ) : null}
                  <div className={`${styles.kvKey} ${styles.mt8}`}>响应体</div>
                  <pre className={styles.codeBlock}>
                    {typeof run.responseBody === 'string'
                      ? run.responseBody
                      : JSON.stringify(run.responseBody, null, 2)}
                  </pre>
                  {run.truncated ? <div className={styles.tiny}>响应已截断（&gt;64KB）</div> : null}
                  <pre className={styles.codeBlock}>{buildCurl(run)}</pre>
                  <div className={styles.rowActions}>
                    <button
                      type="button"
                      className={`${styles.button} ${styles.buttonSmall}`}
                      onClick={() => void navigator.clipboard?.writeText(run.requestId ?? '')}
                      disabled={!run.requestId}
                    >
                      复制 requestId
                    </button>
                    <button
                      type="button"
                      className={`${styles.button} ${styles.buttonSmall}`}
                      onClick={() => void navigator.clipboard?.writeText(buildCurl(run))}
                    >
                      复制 cURL
                    </button>
                    <button
                      type="button"
                      className={`${styles.button} ${styles.buttonSmall} ${styles.buttonDanger}`}
                      onClick={() => setDefectFor(run)}
                    >
                      记录为缺陷
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {defectFor ? (
        <DefectComposer
          run={defectFor}
          onClose={() => setDefectFor(null)}
          onCreated={() => setDefectFor(null)}
        />
      ) : null}
    </aside>
  );
}
