import { useState } from 'react';
import { addDefect, nextDefectId } from '../lib/run-store';
import styles from '../styles/demo.module.css';
import type { Defect, DefectArea, DefectCategory, DefectSeverity, RunEntry } from '../types';
import { Drawer } from './drawer';
import { Field } from './primitives';

const SEVERITIES: DefectSeverity[] = ['blocker', 'high', 'medium', 'low'];
const AREAS: DefectArea[] = [
  'dataset',
  'collection',
  'data',
  'search',
  'training',
  'delete',
  'acl',
  'file',
  'import-export',
  'ui',
];
const CATEGORIES: DefectCategory[] = [
  'BACKEND-BUG',
  'BACKEND-GAP',
  'UI-BUG',
  'CONTRACT-MISMATCH',
  'ENV-BLOCKER',
  'FASTGPT-DIFF',
];

function suggestTitle(run: RunEntry): string {
  const key = run.messageKey ?? `HTTP ${run.status}`;
  return `${run.method} ${run.path} → ${key}`;
}

function suggestActual(run: RunEntry): string {
  const parts = [`HTTP ${run.status}`, `code ${run.code}`];
  if (run.messageKey) parts.push(`messageKey=${run.messageKey}`);
  if (run.requestId) parts.push(`requestId=${run.requestId}`);
  return parts.join(' · ');
}

/** 从一条真实失败调用生成缺陷记录（不允许凭空造缺陷）。 */
export function DefectComposer({
  run,
  onClose,
  onCreated,
}: {
  run: RunEntry;
  onClose: () => void;
  onCreated: (defect: Defect) => void;
}) {
  const [title, setTitle] = useState(suggestTitle(run));
  const [severity, setSeverity] = useState<DefectSeverity>('high');
  const [area, setArea] = useState<DefectArea>('dataset');
  const [category, setCategory] = useState<DefectCategory>('BACKEND-BUG');
  const [expected, setExpected] = useState('该请求应返回 200 并完成对应操作');
  const [actual, setActual] = useState(suggestActual(run));
  const [steps, setSteps] = useState(
    `1. 打开 ${run.scenarioId ? `场景 ${run.scenarioId} 的步骤 ${run.stepId}` : '对应页面'}\n2. 触发 ${run.method} ${run.path}\n3. 观察响应`,
  );
  const [note, setNote] = useState('');

  const submit = () => {
    const defect: Defect = {
      id: nextDefectId(),
      title: title.trim() || suggestTitle(run),
      severity,
      area,
      category,
      expected,
      actual,
      steps: steps
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
      runEntryRef: run.seq,
      ...(run.requestId ? { requestId: run.requestId } : {}),
      createdAt: new Date().toISOString(),
      status: 'open',
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    addDefect(defect);
    onCreated(defect);
  };

  return (
    <Drawer
      title={`记录缺陷 · #${String(run.seq).padStart(3, '0')}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={styles.button} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className={`${styles.button} ${styles.buttonPrimary}`}
            onClick={submit}
          >
            保存缺陷
          </button>
        </>
      }
    >
      <Field label="标题" required htmlFor="defect-title">
        <input
          id="defect-title"
          className={styles.input}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </Field>
      <div className={styles.inline}>
        <Field label="严重度" htmlFor="defect-severity">
          <select
            id="defect-severity"
            className={styles.select}
            value={severity}
            onChange={(event) => setSeverity(event.target.value as DefectSeverity)}
          >
            {SEVERITIES.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </Field>
        <Field label="区域" htmlFor="defect-area">
          <select
            id="defect-area"
            className={styles.select}
            value={area}
            onChange={(event) => setArea(event.target.value as DefectArea)}
          >
            {AREAS.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </Field>
        <Field label="分类" htmlFor="defect-category">
          <select
            id="defect-category"
            className={styles.select}
            value={category}
            onChange={(event) => setCategory(event.target.value as DefectCategory)}
          >
            {CATEGORIES.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="期望" htmlFor="defect-expected">
        <textarea
          id="defect-expected"
          className={styles.textarea}
          value={expected}
          onChange={(event) => setExpected(event.target.value)}
        />
      </Field>
      <Field label="实际" htmlFor="defect-actual">
        <textarea
          id="defect-actual"
          className={styles.textarea}
          value={actual}
          onChange={(event) => setActual(event.target.value)}
        />
      </Field>
      <Field label="复现步骤" hint="每行一步" htmlFor="defect-steps">
        <textarea
          id="defect-steps"
          className={styles.textarea}
          value={steps}
          onChange={(event) => setSteps(event.target.value)}
        />
      </Field>
      <Field label="备注" htmlFor="defect-note">
        <input
          id="defect-note"
          className={styles.input}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="可选"
        />
      </Field>
      <div className={styles.tiny}>
        关联调用 #{String(run.seq).padStart(3, '0')} · requestId {run.requestId ?? '—'}
      </div>
    </Drawer>
  );
}
