import { useEffect, useRef, type ReactNode } from 'react';
import styles from '../styles/demo.module.css';

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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    panelRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className={styles.drawerBackdrop} role="presentation" onClick={onClose}>
      <div
        className={styles.drawer}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panelRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.drawerHead}>
          <strong>{title}</strong>
          <span className={styles.topSpacer} />
          <button
            type="button"
            className={`${styles.button} ${styles.buttonSmall}`}
            onClick={onClose}
            aria-label="关闭"
          >
            关闭
          </button>
        </div>
        <div className={styles.drawerBody}>{children}</div>
        {footer ? <div className={styles.drawerFoot}>{footer}</div> : null}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  targetName,
  impact,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  targetName: string;
  impact: string;
  confirmLabel: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    dialogRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className={styles.drawerBackdrop} role="presentation" onClick={onCancel}>
      <div
        className={styles.drawer}
        style={{
          width: 'min(440px, 100%)',
          height: 'auto',
          margin: 'auto',
          borderLeft: 'none',
          borderRadius: 6,
        }}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.drawerHead}>
          <strong>{title}</strong>
        </div>
        <div className={styles.drawerBody}>
          <div className={styles.mb8}>
            对象：<span className={styles.mono}>{targetName}</span>
          </div>
          <div className={styles.muted}>{impact}</div>
        </div>
        <div className={styles.drawerFoot}>
          <button type="button" className={styles.button} onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className={`${styles.button} ${styles.buttonDanger}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? '处理中…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
