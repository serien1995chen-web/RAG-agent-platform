import { useState } from 'react';
import { DemoShell } from '../../../../demo/kb/components/demo-shell';
import { EmptyState, StatusText } from '../../../../demo/kb/components/primitives';
import { rememberId, saveScenario } from '../../../../demo/kb/lib/run-store';
import { SCENARIOS, emptyRun, summarize, type ScenarioDef } from '../../../../demo/kb/lib/scenarios';
import { useDemoStore } from '../../../../demo/kb/lib/use-demo-store';
import styles from '../../../../demo/kb/styles/demo.module.css';
import type { ScenarioRun, ScenarioStepState } from '../../../../demo/kb/types';

const BASELINE_COMMIT = process.env.NEXT_PUBLIC_DEMO_BASELINE_COMMIT ?? 'unknown';
const BASELINE_BRANCH = process.env.NEXT_PUBLIC_DEMO_BASELINE_BRANCH ?? 'unknown';

function download(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export default function DemoRunsPage() {
  const { scenarios } = useDemoStore();
  const [activeId, setActiveId] = useState(SCENARIOS[0]?.scenarioId ?? 'S1');
  const [steps, setSteps] = useState<ScenarioStepState[]>([]);
  const [running, setRunning] = useState(false);
  const [currentRun, setCurrentRun] = useState<ScenarioRun | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const active: ScenarioDef | undefined = SCENARIOS.find((item) => item.scenarioId === activeId);

  const selectScenario = (id: string) => {
    setActiveId(id);
    const def = SCENARIOS.find((item) => item.scenarioId === id);
    setSteps(def ? def.steps.map((step) => ({ stepId: step.stepId, title: step.title, status: 'idle' })) : []);
    setCurrentRun(null);
    setMessage(null);
  };

  const run = async (def: ScenarioDef) => {
    setRunning(true);
    setMessage(null);
    const started = emptyRun(def, { commit: BASELINE_COMMIT, branch: BASELINE_BRANCH });
    const state: Record<string, unknown> = {};
    const stepStates: ScenarioStepState[] = def.steps.map((step) => ({
      stepId: step.stepId,
      title: step.title,
      status: 'idle',
    }));
    setSteps(stepStates);
    setCurrentRun({ ...started, steps: stepStates });

    const created: { kind: string; id: string }[] = [];
    let aborted = false;

    for (let index = 0; index < def.steps.length; index += 1) {
      const step = def.steps[index]!;
      if (aborted) {
        stepStates[index] = { ...stepStates[index]!, status: 'skipped' };
        setSteps([...stepStates]);
        continue;
      }
      const startedAt = new Date().toISOString();
      stepStates[index] = { ...stepStates[index]!, status: 'running', startedAt };
      setSteps([...stepStates]);

      try {
        const outcome = await step.run({
          scenarioId: def.scenarioId,
          stepId: step.stepId,
          state,
          remember: (kind, id) => {
            if (!id) return;
            rememberId(kind, id);
            created.push({ kind, id });
          },
        });
        stepStates[index] = {
          ...stepStates[index]!,
          status: outcome.status,
          detail: outcome.detail,
          finishedAt: new Date().toISOString(),
          ...(outcome.seq !== undefined ? { runEntrySeq: outcome.seq } : {}),
        };
        if (outcome.status !== 'passed') aborted = true;
      } catch (error) {
        stepStates[index] = {
          ...stepStates[index]!,
          status: 'failed',
          detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          finishedAt: new Date().toISOString(),
        };
        aborted = true;
      }
      setSteps([...stepStates]);
      setCurrentRun({ ...started, steps: [...stepStates], summary: summarize(stepStates) });
    }

    const finished: ScenarioRun = {
      ...started,
      finishedAt: new Date().toISOString(),
      steps: stepStates,
      summary: summarize(stepStates),
      createdIds: created,
    };
    saveScenario(finished);
    setCurrentRun(finished);
    setRunning(false);
    setMessage(
      `场景 ${def.scenarioId} 完成：通过 ${finished.summary.passed} / 失败 ${finished.summary.failed} / 阻塞 ${finished.summary.blocked}`,
    );
  };

  return (
    <DemoShell title="验收场景" breadcrumb={`${SCENARIOS.length} 个可执行场景 · 每步调用真实 API`}>
      <div className={styles.split}>
        <section className={`${styles.panel} ${styles.panelPad}`}>
          <div className={styles.tabs} role="tablist">
            {SCENARIOS.map((item) => (
              <button
                key={item.scenarioId}
                type="button"
                role="tab"
                aria-selected={activeId === item.scenarioId}
                className={`${styles.tab} ${activeId === item.scenarioId ? styles.tabActive : ''}`}
                onClick={() => selectScenario(item.scenarioId)}
              >
                {item.scenarioId}
              </button>
            ))}
          </div>

          {active ? (
            <>
              <h2 className={styles.sectionTitle}>
                {active.scenarioId} {active.title}
              </h2>
              <div className={`${styles.small} ${styles.muted} ${styles.mb12}`}>{active.description}</div>
              <div className={styles.rowActions}>
                <button
                  type="button"
                  className={`${styles.button} ${styles.buttonPrimary}`}
                  onClick={() => void run(active)}
                  disabled={running}
                >
                  {running ? '执行中…' : '运行场景'}
                </button>
                {currentRun ? (
                  <button
                    type="button"
                    className={styles.button}
                    onClick={() =>
                      download(
                        `${currentRun.scenarioId}-${currentRun.startedAt.replace(/[:.]/g, '-')}.json`,
                        JSON.stringify(currentRun, null, 2),
                      )
                    }
                  >
                    导出本次运行
                  </button>
                ) : null}
              </div>
              {message ? <div className={`${styles.mt12} ${styles.small}`}>{message}</div> : null}

              <div className={`${styles.timeline} ${styles.mt16}`}>
              {(steps.length > 0
                ? steps
                : active.steps.map<ScenarioStepState>((step) => ({
                    stepId: step.stepId,
                    title: step.title,
                    status: 'idle',
                  }))
              ).map((step, index) => (
                  <div key={step.stepId} className={styles.timelineRow}>
                    <span
                      className={styles.timelineDot}
                      style={{
                        background:
                          step.status === 'passed'
                            ? 'var(--ok)'
                            : step.status === 'failed'
                              ? 'var(--err)'
                              : step.status === 'blocked'
                                ? 'var(--warn)'
                                : 'var(--hair)',
                      }}
                    />
                    <div>
                      <div className={styles.flex}>
                        <span className={styles.mono}>{step.stepId}</span>
                        <span>{step.title}</span>
                        <StatusText status={step.status} />
                      </div>
                      {step.detail ? <div className={`${styles.tiny} ${styles.muted}`}>{step.detail}</div> : null}
                      {step.runEntrySeq ? (
                        <div className={`${styles.tiny} ${styles.mono}`}>run #{String(step.runEntrySeq).padStart(3, '0')}</div>
                      ) : null}
                      {step.status === 'idle' && index === 0 ? (
                        <div className={styles.tiny}>从这一步开始执行</div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <EmptyState title="未选择场景" />
          )}
        </section>

        <section className={`${styles.panel} ${styles.panelPad}`}>
          <h2 className={styles.sectionTitle}>历史运行（{scenarios.length}）</h2>
          {scenarios.length === 0 ? (
            <EmptyState title="还没有运行记录" hint="运行任一场景后在此显示。" />
          ) : (
            <div className={styles.timeline}>
              {scenarios.map((item) => (
                <div key={item.startedAt} className={styles.timelineRow}>
                  <span
                    className={styles.timelineDot}
                    style={{
                      background:
                        item.summary.failed > 0
                          ? 'var(--err)'
                          : item.summary.blocked > 0
                            ? 'var(--warn)'
                            : 'var(--ok)',
                    }}
                  />
                  <div>
                    <div>
                      <strong>{item.scenarioId}</strong> {item.title}
                    </div>
                    <div className={styles.tiny}>
                      通过 {item.summary.passed} · 失败 {item.summary.failed} · 阻塞 {item.summary.blocked}
                    </div>
                    <div className={styles.tiny}>{new Date(item.startedAt).toLocaleString('zh-CN')}</div>
                    <button
                      type="button"
                      className={`${styles.button} ${styles.buttonSmall} ${styles.mt8}`}
                      onClick={() =>
                        download(
                          `${item.scenarioId}-${item.startedAt.replace(/[:.]/g, '-')}.json`,
                          JSON.stringify(item, null, 2),
                        )
                      }
                    >
                      导出
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </DemoShell>
  );
}
