import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import styles from '../styles/kb.module.css';
import { KbRequestError } from '../lib/kb-api';
import { trainingStateLabel, trainingTone } from '../lib/format';

export type IconName =
  | 'plus'
  | 'search'
  | 'refresh'
  | 'left'
  | 'right'
  | 'close'
  | 'database'
  | 'folder'
  | 'settings'
  | 'shield'
  | 'activity'
  | 'file'
  | 'trash'
  | 'edit'
  | 'menu'
  | 'download'
  | 'upload'
  | 'more';

const ICONS: Record<IconName, ReactNode> = {
  plus: <path d="M8 3v10M3 8h10" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3" />
    </>
  ),
  refresh: (
    <>
      <path d="M13 8a5 5 0 1 1-1.6-3.7" />
      <path d="M13 2v3.5H9.5" />
    </>
  ),
  left: <path d="m10 3-5 5 5 5" />,
  right: <path d="m6 3 5 5-5 5" />,
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  database: (
    <>
      <ellipse cx="8" cy="4" rx="5.5" ry="2" />
      <path d="M2.5 4v4c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V4" />
      <path d="M2.5 8v4c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V8" />
    </>
  ),
  folder: <path d="M2 4.5h4l1.2 1.5H14v7H2z" />,
  settings: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M12.4 3.6l-1 1M4.6 11.4l-1 1" />
    </>
  ),
  shield: <path d="M8 1.8 13 4v4c0 3-2.2 5.2-5 6.2C5.2 13.2 3 11 3 8V4z" />,
  activity: <path d="M1.5 8h3l1.5-4 2.5 8 1.5-4h4.5" />,
  file: (
    <>
      <path d="M3 1.8h6l4 4v8.4H3z" />
      <path d="M9 1.8v4h4" />
    </>
  ),
  trash: (
    <>
      <path d="M2.5 4.5h11M5 4.5V2.8h6v1.7M4 4.5l.7 9h6.6l.7-9" />
      <path d="M6.5 7v4M9.5 7v4" />
    </>
  ),
  edit: (
    <>
      <path d="m2.5 11.5 1-3L11 1l3 3-7.5 7.5z" />
      <path d="m9.5 2.5 3 3" />
    </>
  ),
  menu: <path d="M2 4h12M2 8h12M2 12h12" />,
  download: (
    <>
      <path d="M8 2v8M4.5 7 8 10.5 11.5 7" />
      <path d="M2.5 12.5h11" />
    </>
  ),
  upload: (
    <>
      <path d="M8 12V4M4.5 7 8 3.5 11.5 7" />
      <path d="M2.5 12.5h11" />
    </>
  ),
  more: (
    <>
      <circle cx="3" cy="8" r=".9" />
      <circle cx="8" cy="8" r=".9" />
      <circle cx="13" cy="8" r=".9" />
    </>
  ),
};

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      className={styles.icon}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
  );
}

export function Button({
  variant = 'ghost',
  size = 'md',
  loading,
  icon,
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger' | 'subtle';
  size?: 'sm' | 'md';
  loading?: boolean;
  icon?: IconName;
}) {
  return (
    <button
      type="button"
      className={[
        styles.button,
        styles[`button${variant[0]?.toUpperCase()}${variant.slice(1)}`],
        size === 'sm' ? styles.buttonSmall : '',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      disabled={loading || props.disabled}
      {...props}
    >
      {loading ? <span className={styles.spinner} aria-hidden="true" /> : null}
      {!loading && icon ? <Icon name={icon} size={14} /> : null}
      <span>{children}</span>
    </button>
  );
}

export function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>
        {label}
        {required ? <span className={styles.required}> *</span> : null}
      </span>
      {children}
      {hint ? <span className={styles.fieldHint}>{hint}</span> : null}
      {error ? <span className={styles.fieldError}>{error}</span> : null}
    </label>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${styles.input} ${props.className ?? ''}`} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${styles.textarea} ${props.className ?? ''}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${styles.select} ${props.className ?? ''}`} />;
}

export function Badge({
  tone = 'muted',
  children,
}: {
  tone?: 'ok' | 'warn' | 'err' | 'muted' | 'info';
  children: ReactNode;
}) {
  return (
    <span className={`${styles.badge} ${styles[`badge${tone[0]?.toUpperCase()}${tone.slice(1)}`]}`}>
      {children}
    </span>
  );
}

export function StatusBadge({ state }: { state?: string | null }) {
  return <Badge tone={trainingTone(state)}>{trainingStateLabel(state)}</Badge>;
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
      {hint ? <div className={styles.muted}>{hint}</div> : null}
      {action ? <div className={styles.emptyAction}>{action}</div> : null}
    </div>
  );
}

export function Spinner({ label = '加载中' }: { label?: string }) {
  return (
    <div className={styles.loading} role="status">
      <span className={styles.spinner} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function errorDetails(error: unknown): {
  code?: number;
  messageKey?: string;
  requestId?: string;
  params?: Record<string, unknown>;
  message?: string;
} {
  if (error instanceof KbRequestError) return error.payload;
  if (error instanceof Error) return { message: error.message };
  return {};
}

export function InlineError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const detail = errorDetails(error);
  return (
    <div className={styles.errorBox} role="alert">
      <div>
        <strong>{detail.messageKey ?? '请求失败'}</strong>
        {detail.code ? <span className={styles.mono}> · {detail.code}</span> : null}
        {detail.requestId ? (
          <span className={styles.muted}> · requestId {detail.requestId}</span>
        ) : null}
      </div>
      {detail.message ? <div className={styles.muted}>{detail.message}</div> : null}
      {detail.params && Object.keys(detail.params).length > 0 ? (
        <details className={styles.diagnostics}>
          <summary>参数</summary>
          <pre>{JSON.stringify(detail.params, null, 2)}</pre>
        </details>
      ) : null}
      {onRetry ? (
        <div className={styles.mt8}>
          <Button size="sm" icon="refresh" onClick={onRetry}>
            重试
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function Notice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'ok' | 'warn' | 'err';
  children: ReactNode;
}) {
  return (
    <div
      className={`${styles.notice} ${styles[`notice${tone[0]?.toUpperCase()}${tone.slice(1)}`]}`}
    >
      {children}
    </div>
  );
}

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.offsetParent !== null);
}

export function Drawer({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const items = focusables(panelRef.current);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [onClose]);

  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={onClose}>
      <div
        ref={panelRef}
        className={styles.drawer}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className={styles.drawerHead}>
          <h2 id={titleId} className={styles.drawerTitle}>
            {title}
          </h2>
          <Button size="sm" variant="subtle" aria-label="关闭" onClick={onClose}>
            <Icon name="close" />
          </Button>
        </div>
        <div className={styles.drawerBody}>{children}</div>
        {footer ? <div className={styles.drawerFoot}>{footer}</div> : null}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  target,
  impact,
  confirmLabel,
  busy,
  danger = true,
  onCancel,
  onConfirm,
}: {
  title: string;
  target: string;
  impact: string;
  confirmLabel: string;
  busy?: boolean;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={onCancel}>
      <div
        ref={dialogRef}
        className={styles.confirm}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id={titleId} className={styles.drawerTitle}>
          {title}
        </h2>
        <p>
          对象：<span className={styles.mono}>{target}</span>
        </p>
        <p className={styles.muted}>{impact}</p>
        <div className={styles.confirmActions}>
          <Button onClick={onCancel} disabled={busy}>
            取消
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  items,
  onChange,
}: {
  value: T;
  items: { key: T; label: string }[];
  onChange: (key: T) => void;
}) {
  return (
    <div className={styles.tabs} role="tablist" aria-label="知识库标签">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="tab"
          aria-selected={value === item.key}
          className={`${styles.tab} ${value === item.key ? styles.tabActive : ''}`}
          onClick={() => onChange(item.key)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <span className={styles.mono}>{children}</span>;
}
