import { createHash } from 'node:crypto';

export const KNOWLEDGE_QUEUE_NAMES = [
  'knowledge-import',
  'knowledge-parse',
  'knowledge-segment',
  'knowledge-qa',
  'knowledge-ocr',
  'knowledge-caption',
  'knowledge-embed',
  'knowledge-index',
  'knowledge-rebuild',
  'knowledge-sync',
  'knowledge-delete',
  'knowledge-outbox',
  'knowledge-cleanup',
] as const;

export type KnowledgeQueueName = (typeof KNOWLEDGE_QUEUE_NAMES)[number];

export const QUEUE_NAMES = Object.freeze({
  import: 'knowledge-import',
  parse: 'knowledge-parse',
  segment: 'knowledge-segment',
  qa: 'knowledge-qa',
  ocr: 'knowledge-ocr',
  caption: 'knowledge-caption',
  embed: 'knowledge-embed',
  index: 'knowledge-index',
  rebuild: 'knowledge-rebuild',
  sync: 'knowledge-sync',
  delete: 'knowledge-delete',
  outbox: 'knowledge-outbox',
  cleanup: 'knowledge-cleanup',
} as const satisfies Record<string, KnowledgeQueueName>);

export type QueueName = KnowledgeQueueName;
export type JobMode = keyof typeof QUEUE_NAMES;

export interface KnowledgeJobIdInput {
  kind: string;
  resourceId: string;
  version: number | string;
  inputHash: string;
}

export function buildKnowledgeJobId(input: KnowledgeJobIdInput): string {
  const digest = createHash('sha256')
    .update(`${input.kind}\u0000${input.resourceId}\u0000${input.version}\u0000${input.inputHash}`)
    .digest('hex')
    .slice(0, 40);
  return `k_${digest}`;
}

export const JOB_MODE_TO_QUEUE: Readonly<Record<JobMode, KnowledgeQueueName>> = QUEUE_NAMES;
