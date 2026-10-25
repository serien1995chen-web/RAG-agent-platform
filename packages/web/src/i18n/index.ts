import type { KnowledgeErrorCode, KnowledgeProblem } from '@kb/contracts';
import { errorMessageKey } from './error-message-keys';
import { ENUM_MESSAGE_KEYS, type MessageKey } from './messages';
import type { KnowledgeLocale } from './knowledge-i18n-provider';

export { errorMessageKey, ERROR_MESSAGE_KEYS } from './error-message-keys';
export {
  KnowledgeI18nProvider,
  useKnowledgeEnumLabel,
  useKnowledgeI18n,
  type KnowledgeLocale,
} from './knowledge-i18n-provider';
export { messages, type MessageKey } from './messages';

export interface ProblemView {
  code: KnowledgeErrorCode | 'UNKNOWN_ERROR';
  messageKey: MessageKey;
  params: Record<string, string | number>;
  traceId: string;
  requestId: string;
  retryable: boolean;
}

const STATUS_MESSAGE_KEYS: Readonly<Record<string, MessageKey>> = {
  active: 'status.active',
  queued: 'status.queued',
  leased: 'status.leased',
  running: 'status.running',
  completed: 'status.completed',
  canceled: 'status.canceled',
  cancelled: 'status.canceled',
  pausing: 'status.pausing',
  resuming: 'status.resuming',
  blocked: 'status.blocked',
  ready: 'status.ready',
  indexed: 'status.indexed',
  succeeded: 'status.succeeded',
  ok: 'status.ok',
  partial: 'status.partial',
  retry_wait: 'status.retryWait',
  paused: 'status.paused',
  degraded: 'status.degraded',
  pending: 'status.pending',
  draft: 'status.draft',
  failed: 'status.failed',
  dead_letter: 'status.deadLetter',
  error: 'status.error',
  down: 'status.down',
  deleting: 'status.deleting',
  enabled: 'status.enabled',
  disabled: 'status.disabled',
  inherited: 'status.inherited',
  independent: 'status.independent',
};

export function statusMessageKey(value: string): MessageKey {
  return STATUS_MESSAGE_KEYS[value] ?? 'status.unknown';
}

export function enumMessageKey(value: string): MessageKey | null {
  return ENUM_MESSAGE_KEYS[value] ?? null;
}

export function toProblemView(problem: KnowledgeProblem): ProblemView {
  const code = (
    errorMessageKey(problem.error.code) === 'errors.unknown' ? 'UNKNOWN_ERROR' : problem.error.code
  ) as KnowledgeErrorCode | 'UNKNOWN_ERROR';
  const params = Object.fromEntries(
    Object.entries(problem.error.details).filter(
      (entry): entry is [string, string | number] =>
        typeof entry[1] === 'string' || typeof entry[1] === 'number',
    ),
  );
  return {
    code,
    messageKey: errorMessageKey(code),
    params,
    traceId: problem.traceId,
    requestId: problem.requestId,
    retryable: problem.error.retryable,
  };
}

export function formatDate(
  value: string | Date | null | undefined,
  locale: KnowledgeLocale = 'zh-CN',
): string {
  if (!value) return '-';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime())
    ? '-'
    : new Intl.DateTimeFormat(locale, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(date);
}
