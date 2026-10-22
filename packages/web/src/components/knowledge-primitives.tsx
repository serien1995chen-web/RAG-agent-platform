'use client';

import type {
  ButtonHTMLAttributes,
  FormEvent,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { KnowledgeRequestError } from '../client/knowledge-client';

export function PageHeader(props: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        {props.eyebrow ? <p className="eyebrow">{props.eyebrow}</p> : null}
        <h1>{props.title}</h1>
        {props.description ? <p className="page-description">{props.description}</p> : null}
      </div>
      {props.actions ? <div className="page-actions">{props.actions}</div> : null}
    </header>
  );
}

export function Section(props: {
  title: string;
  meta?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="section">
      <header className="section-header">
        <div>
          <h2>{props.title}</h2>
          {props.meta ? <span>{props.meta}</span> : null}
        </div>
        {props.actions ? <div className="section-actions">{props.actions}</div> : null}
      </header>
      {props.children}
    </section>
  );
}

export function Button(
  props: ButtonHTMLAttributes<HTMLButtonElement> & {
    tone?: 'primary' | 'secondary' | 'danger';
    busy?: boolean;
  },
) {
  const { tone = 'secondary', busy = false, children, disabled, ...rest } = props;
  return (
    <button
      {...rest}
      className={`button button-${tone}${rest.className ? ` ${rest.className}` : ''}`}
      disabled={disabled || busy}
      aria-busy={busy}
    >
      {busy ? 'Working...' : children}
    </button>
  );
}

export function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      {props.children}
      {props.hint ? <span className="field-hint">{props.hint}</span> : null}
    </label>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input {...props} className={`text-input${props.className ? ` ${props.className}` : ''}`} />
  );
}

export function SelectInput(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={`text-input${props.className ? ` ${props.className}` : ''}`} />
  );
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`text-input text-area${props.className ? ` ${props.className}` : ''}`}
    />
  );
}

export function StatusTag(props: {
  value: string;
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
}) {
  return <span className={`status-tag status-${props.tone ?? 'neutral'}`}>{props.value}</span>;
}

export function LoadingState(props: { label?: string }) {
  return (
    <div className="loading-state" role="status">
      <span className="loading-rule" />
      {props.label ?? 'Loading data from the knowledge API…'}
    </div>
  );
}

export function EmptyState(props: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <h3>{props.title}</h3>
      <p>{props.description}</p>
      {props.action}
    </div>
  );
}

export function ProblemNotice(props: { error: unknown }) {
  if (!props.error) return null;
  if (props.error instanceof KnowledgeRequestError) {
    return (
      <div className="problem-notice" role="alert">
        <strong>{props.error.problem.error.code}</strong>
        <span>{props.error.problem.error.message}</span>
        <small>
          trace {props.error.problem.traceId} | request {props.error.problem.requestId}
        </small>
      </div>
    );
  }
  return (
    <div className="problem-notice" role="alert">
      <strong>Request failed</strong>
      <span>
        {props.error instanceof Error ? props.error.message : 'The request could not be completed.'}
      </span>
    </div>
  );
}

export interface Column<T> {
  key: string;
  label: string;
  render: (row: T) => ReactNode;
}

export function DataTable<T>(props: {
  rows: readonly T[];
  columns: readonly Column<T>[];
  rowKey: (row: T) => string;
  empty: string;
}) {
  if (props.rows.length === 0) return <p className="table-empty">{props.empty}</p>;
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            {props.columns.map((column) => (
              <th key={column.key} scope="col">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => (
            <tr key={props.rowKey(row)}>
              {props.columns.map((column) => (
                <td key={column.key}>{column.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FormBand(props: {
  title: string;
  description?: string;
  submitLabel: string;
  busy?: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
}) {
  return (
    <form className="form-band" onSubmit={props.onSubmit}>
      <div className="form-intro">
        <h2>{props.title}</h2>
        {props.description ? <p>{props.description}</p> : null}
      </div>
      <div className="form-fields">{props.children}</div>
      <div className="form-actions">
        <Button type="submit" tone="primary" busy={props.busy}>
          {props.submitLabel}
        </Button>
      </div>
    </form>
  );
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '-';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime())
    ? '-'
    : new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(date);
}
