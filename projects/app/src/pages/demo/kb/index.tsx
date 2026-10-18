import Link from 'next/link';
import { useCallback, useState } from 'react';
import { DemoShell } from '../../../demo/kb/components/demo-shell';
import { EmptyState, Stat } from '../../../demo/kb/components/primitives';
import { api } from '../../../demo/kb/lib/api';
import { computeCoverage, coverageSummary } from '../../../demo/kb/lib/coverage';
import { useDemoStore } from '../../../demo/kb/lib/use-demo-store';
import { useOnce } from '../../../demo/kb/lib/use-once';
import styles from '../../../demo/kb/styles/demo.module.css';

const BASELINE = process.env.NEXT_PUBLIC_DEMO_BASELINE_COMMIT ?? 'unknown';

export default function DemoOverviewPage() {
  const { runs, defects, scenarios } = useDemoStore();
  const [datasetTotal, setDatasetTotal] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await api.listDatasets({ limit: 50 });
    if (!result.ok) {
      setLoadError(`${result.entry.status} · ${result.entry.messageKey ?? 'unknown'}`);
      return;
    }
    setDatasetTotal(result.envelope.data?.total ?? 0);
  }, []);

  useOnce(() => {
    void load();
  });

  const coverage = computeCoverage(runs);
  const summary = coverageSummary(coverage);
  const failureCount = runs.filter((run) => run.status >= 400 || run.code >= 400 || run.status === 0).length;
  const avg = runs.length
    ? Math.round(runs.reduce((acc, run) => acc + run.durationMs, 0) / runs.length)
    : 0;
  const latest = scenarios[0];

  return (
    <DemoShell title="概览" breadcrumb={`基线 ${BASELINE.slice(0, 7)} · 仅知识库模块`}>
      {loadError ? (
        <div className={styles.banner}>
          知识库列表读取失败：{loadError}
          <div className={styles.bannerMeta}>打开运行脊柱可查看 requestId 与原始响应。</div>
        </div>
      ) : null}

      <div className={styles.statGrid}>
        <Stat label="知识库总数" value={datasetTotal ?? '—'} hint="来自 /api/core/dataset/list" />
        <Stat label="本会话调用" value={runs.length} hint={`失败 ${failureCount} 次`} />
        <Stat label="平均耗时" value={`${avg}ms`} hint="本会话全部调用" />
        <Stat label="缺陷" value={defects.length} hint="点击缺陷记录查看详情" />
      </div>

      <div className={`${styles.split} ${styles.mt16}`}>
        <section className={`${styles.panel} ${styles.panelPad}`}>
          <h2 className={styles.sectionTitle}>API 覆盖</h2>
          <div className={styles.flex}>
            <span className={`${styles.badge} ${styles.badgeOk}`}>已测通过 {summary.passed}</span>
            <span className={`${styles.badge} ${styles.badgeErr}`}>已测失败 {summary.failed}</span>
            <span className={`${styles.badge} ${styles.badgeMuted}`}>未测 {summary.untested}</span>
            <span className={`${styles.badge} ${styles.badgeWarn}`}>不适用 {summary.notApplicable}</span>
          </div>
          <div className={`${styles.progress} ${styles.mt12}`} aria-hidden="true">
            <div
              className={styles.progressBar}
              style={{ width: `${Math.round(((summary.passed + summary.failed) / Math.max(summary.total, 1)) * 100)}%` }}
            />
          </div>
          <div className={styles.tiny}>
            已触达 {summary.passed + summary.failed} / {summary.total} 条注册路由
          </div>
          <div className={styles.mt12}>
            <Link className={styles.button} href="/demo/kb/coverage">
              查看覆盖矩阵
            </Link>
          </div>
        </section>

        <section className={`${styles.panel} ${styles.panelPad}`}>
          <h2 className={styles.sectionTitle}>最近一次验收运行</h2>
          {latest ? (
            <div className={styles.timeline}>
              <div className={styles.timelineRow}>
                <span className={styles.timelineDot} style={{ background: 'var(--signal)' }} />
                <div>
                  <div>
                    <strong>{latest.scenarioId}</strong> {latest.title}
                  </div>
                  <div className={styles.tiny}>
                    通过 {latest.summary.passed} · 失败 {latest.summary.failed} · 阻塞 {latest.summary.blocked}
                  </div>
                  <div className={styles.tiny}>{new Date(latest.startedAt).toLocaleString('zh-CN')}</div>
                </div>
              </div>
            </div>
          ) : (
            <EmptyState
              title="还没有运行过场景"
              hint="去验收场景页执行 S1 或 S2。"
              action={
                <Link className={styles.button} href="/demo/kb/runs">
                  打开验收场景
                </Link>
              }
            />
          )}
        </section>
      </div>

      <section className={`${styles.panel} ${styles.panelPad} ${styles.mt16}`}>
        <h2 className={styles.sectionTitle}>最近调用</h2>
        {runs.length === 0 ? (
          <EmptyState title="暂无调用记录" hint="打开知识库列表或执行一个场景后，这里会出现记录。" />
        ) : (
          <table className={`${styles.table} ${styles.tableCardMode}`}>
            <thead>
              <tr>
                <th>#</th>
                <th>方法</th>
                <th>路径</th>
                <th className={styles.num}>HTTP</th>
                <th className={styles.num}>code</th>
                <th className={styles.num}>耗时</th>
              </tr>
            </thead>
            <tbody>
              {runs.slice(0, 8).map((run) => (
                <tr key={run.seq}>
                  <td data-label="#">{String(run.seq).padStart(3, '0')}</td>
                  <td data-label="方法">{run.method}</td>
                  <td data-label="路径" className={styles.mono}>
                    {run.path.split('?')[0]}
                  </td>
                  <td data-label="HTTP" className={styles.num}>
                    {run.status || 'ERR'}
                  </td>
                  <td data-label="code" className={styles.num}>
                    {run.code}
                  </td>
                  <td data-label="耗时" className={styles.num}>
                    {run.durationMs}ms
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </DemoShell>
  );
}
