import type { ReactNode } from 'react';
import type { CoverageStatus } from '../lib/coverage';
import styles from '../styles/demo.module.css';
import type { DefectSeverity, StepStatus } from '../types';

export function StatusText({ status, label }: { status: StepStatus; label?: string }) {
  const map: Record<StepStatus, { text: string; color: string }> = {
    idle: { text: '未开始', color: 'var(--muted)' },
    running: { text: '进行中', color: 'var(--warn)' },
    passed: { text: '通过', color: 'var(--ok)' },
    failed: { text: '失败', color: 'var(--err)' },
    blocked: { text: '阻塞', color: 'var(--warn)' },
    skipped: { text: '跳过', color: 'var(--muted)' },
  };
  const item = map[status] ?? { text: status, color: 'var(--muted)' };
  return (
    <span className={styles.status}>
      <span className={styles.statusMark} style={{ background: item.color }} aria-hidden="true" />
      <span>{label ?? item.text}</span>
    </span>
  );
}

const coverageMap: Record<CoverageStatus, { text: string; cls: string | undefined }> = {
  passed: { text: '已测通过', cls: styles.badgeOk },
  failed: { text: '已测失败', cls: styles.badgeErr },
  untested: { text: '未测', cls: styles.badgeMuted },
  'not-applicable': { text: '不适用', cls: styles.badgeWarn },
};

export function CoverageBadge({ status }: { status: CoverageStatus }) {
  const item = coverageMap[status] ?? { text: status, cls: styles.badgeMuted };
  return <span className={`${styles.badge} ${item.cls}`}>{item.text}</span>;
}

export function HttpBadge({ status, code }: { status: number; code: number }) {
  const ok = status >= 200 && status < 300 && code === 200;
  return (
    <span className={`${styles.badge} ${ok ? styles.badgeOk : styles.badgeErr}`}>
      {status}
      {code && code !== status ? ` / ${code}` : ''}
    </span>
  );
}

export const severityRank: Record<DefectSeverity, number> = {
  blocker: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export const severityText: Record<DefectSeverity, string> = {
  blocker: '阻断',
  high: '高',
  medium: '中',
  low: '低',
};

export function SeverityBadge({ severity }: { severity: DefectSeverity }) {
  const cls =
    severity === 'blocker' || severity === 'high'
      ? styles.badgeErr
      : severity === 'medium'
        ? styles.badgeWarn
        : styles.badgeMuted;
  return (
    <span className={`${styles.badge} ${cls}`} title={severity}>
      {severityText[severity]}
    </span>
  );
}

export function Field({
  label,
  required,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel} htmlFor={htmlFor}>
        {label}
        {required ? <span className={styles.fieldRequired}> *</span> : null}
      </label>
      {children}
      {hint ? <span className={styles.fieldHint}>{hint}</span> : null}
      {error ? <span className={styles.fieldError}>{error}</span> : null}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className={styles.empty}>
      <div className={styles.emptyTitle}>{title}</div>
      {hint ? <div>{hint}</div> : null}
      {action ? <div className={styles.mt12}>{action}</div> : null}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
}) {
  return (
    <div className={styles.stat}>
      <div className={styles.statLabel}>{label}</div>
      <div className={styles.statValue}>{value}</div>
      {hint ? <div className={styles.statHint}>{hint}</div> : null}
    </div>
  );
}

export function Glyph({ name }: { name: 'overview' | 'datasets' | 'runs' | 'coverage' | 'defects' | 'runtime' }) {
  const paths: Record<string, ReactNode> = {
    overview: (
      <>
        <rect x="2" y="2" width="4.5" height="4.5" />
        <rect x="8.5" y="2" width="4.5" height="4.5" />
        <rect x="2" y="8.5" width="4.5" height="4.5" />
        <rect x="8.5" y="8.5" width="4.5" height="4.5" />
      </>
    ),
    datasets: (
      <>
        <path d="M2 4.5c0-1.4 2.7-2.5 6-2.5s6 1.1 6 2.5-2.7 2.5-6 2.5-6-1.1-6-2.5Z" />
        <path d="M2 4.5v4c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-4" />
        <path d="M2 8.5v4c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-4" />
      </>
    ),
    runs: (
      <>
        <path d="M2 3h12M2 8h12M2 13h12" />
        <circle cx="4" cy="3" r="1" />
        <circle cx="4" cy="8" r="1" />
        <circle cx="4" cy="13" r="1" />
      </>
    ),
    coverage: (
      <>
        <rect x="2" y="2" width="12" height="12" rx="1" />
        <path d="M2 6h12M6 2v12" />
      </>
    ),
    defects: (
      <>
        <path d="M8 2 14 13H2L8 2Z" />
        <path d="M8 6v3M8 11v.5" />
      </>
    ),
    runtime: (
      <>
        <circle cx="8" cy="8" r="5.5" />
        <path d="M8 5v3l2 1.5" />
      </>
    ),
  };
  return (
    <svg className={styles.navGlyph} viewBox="0 0 16 16" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}
