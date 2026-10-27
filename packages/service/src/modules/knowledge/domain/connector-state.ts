import { createKnowledgeError } from '@kb/contracts';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';

export type ConnectorState = 'active' | 'syncing' | 'paused' | 'failed' | 'deleting' | 'deleted';

const CONNECTOR_TRANSITIONS: Readonly<Record<ConnectorState, readonly ConnectorState[]>> = {
  active: ['syncing', 'paused', 'failed', 'deleting'],
  syncing: ['active', 'failed', 'deleting'],
  paused: ['active', 'deleting'],
  failed: ['active', 'syncing', 'paused', 'deleting'],
  deleting: ['deleted'],
  deleted: [],
};

export function canTransitionConnector(from: ConnectorState, to: ConnectorState): boolean {
  return CONNECTOR_TRANSITIONS[from].includes(to);
}

export function assertConnectorTransition(
  from: ConnectorState,
  to: ConnectorState,
  context: Pick<TenantContext, 'requestId' | 'traceId'>,
): void {
  if (!canTransitionConnector(from, to)) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_CONFLICT',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { from, to, stateMachine: 'connector' },
    });
  }
}
