import { useCallback, useState } from 'react';
import { DemoShell } from '../../../../demo/kb/components/demo-shell';
import { EmptyState, Stat, StatusText } from '../../../../demo/kb/components/primitives';
import { api } from '../../../../demo/kb/lib/api';
import { demoFetch } from '../../../../demo/kb/lib/demo-fetch';
import { useDemoStore } from '../../../../demo/kb/lib/use-demo-store';
import { useOnce } from '../../../../demo/kb/lib/use-once';
import styles from '../../../../demo/kb/styles/demo.module.css';

const COMMIT = process.env.NEXT_PUBLIC_DEMO_BASELINE_COMMIT ?? 'unknown';
const BRANCH = process.env.NEXT_PUBLIC_DEMO_BASELINE_BRANCH ?? 'unknown';
const WORKER_MODE = process.env.NEXT_PUBLIC_DEMO_WORKER_MODE ?? 'unknown';
const IDENTITY = process.env.NEXT_PUBLIC_DEMO_IDENTITY ?? 'unknown';

interface Probe {
  name: string;
  status: string;
  durationMs?: number;
}

export default function DemoRuntimePage() {
  const { runs } = useDemoStore();
  const [ready, setReady] = useState<Probe[] | null>(null);
  const [startup, setStartup] = useState<Probe[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [whoami, setWhoami] = useState<string>('unknown');

  const load = useCallback(async () => {
    const [readyResult, startupResult] = await Promise.all([api.health(), api.startup()]);
    setReady((readyResult.envelope.data?.checks ?? []) as Probe[]);
    setStartup((startupResult.envelope.data?.checks ?? []) as Probe[]);
    setLoaded(true);
    const probe = await demoFetch<{ datasetId?: string }>({
      method: 'GET',
      path: '/api/core/dataset/list?limit=1',
    });
    setWhoami(
      probe.ok
        ? `可用（HTTP ${probe.entry.status}）`
        : `异常（HTTP ${probe.entry.status} / ${probe.entry.messageKey ?? 'unknown'}）`,
    );
  }, []);

  useOnce(() => {
    void load();
  });

  return (
    <DemoShell title="运行环境" breadcrumb="基线、身份、探针与依赖">
      <div className={styles.statGrid}>
        <Stat label="分支" value={BRANCH} hint="demo 基于当前 HEAD" />
        <Stat label="Commit" value={<span className={styles.mono}>{COMMIT.slice(0, 7)}</span>} hint={COMMIT} />
        <Stat label="Worker" value={WORKER_MODE} hint="APP_WORKER_MODE" />
        <Stat label="本会话调用" value={runs.length} hint="见右侧脊柱" />
      </div>

      <div className={`${styles.split} ${styles.mt16}`}>
        <section className={`${styles.panel} ${styles.panelPad}`}>
          <div className={styles.flex}>
            <h2 className={styles.sectionTitle}>依赖探针</h2>
            <span className={styles.topSpacer} />
            <button type="button" className={styles.button} onClick={() => void load()}>
              重新检测
            </button>
          </div>
          {!loaded ? (
            <EmptyState title="检测中…" />
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>探针</th>
                  <th>状态</th>
                  <th className={styles.num}>耗时</th>
                </tr>
              </thead>
              <tbody>
                {[...(ready ?? []), ...(startup ?? [])].map((probe) => (
                  <tr key={`${probe.name}-${probe.status}`}>
                    <td className={styles.mono}>{probe.name}</td>
                    <td>
                      <StatusText
                        status={probe.status === 'ok' ? 'passed' : probe.status === 'degraded' ? 'blocked' : 'failed'}
                        label={probe.status}
                      />
                    </td>
                    <td className={styles.num}>{probe.durationMs ?? 0}ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className={`${styles.panel} ${styles.panelPad}`}>
          <h2 className={styles.sectionTitle}>身份与能力</h2>
          <div className={styles.kv}>
            <span className={styles.kvKey}>开发身份</span>
            <span className={styles.mono}>{IDENTITY}</span>
            <span className={styles.kvKey}>数据访问</span>
            <span>{whoami}</span>
            <span className={styles.kvKey}>登录页</span>
            <span>不提供（开发态固定身份）</span>
          </div>
          <div className={`${styles.tiny} ${styles.mt12}`}>
            生产环境必须禁用 dev-identity；demo 仅在本地验收使用。
          </div>
        </section>
      </div>
    </DemoShell>
  );
}
