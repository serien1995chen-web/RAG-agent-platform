import { describe, expect, it, vi } from 'vitest';
import type { S06ProcessingApplication } from '@kb/service';
import { S06JobHandlers } from '../../src/runtime/s06-job-handlers';

const workspaceId = 'ws_s6_handler';
const outboxEventId = '64b1fce0b0e84a7bb2e8cbe9';

describe('S6 worker handlers', () => {
  it('rejects malformed or missing queue payload identity before hydration', async () => {
    const processing = {
      hydrateOutbox: vi.fn(),
      handleImport: vi.fn(),
      handleQueue: vi.fn(),
    } as unknown as S06ProcessingApplication;
    const handlers = new S06JobHandlers(processing);
    await expect(
      handlers.import({ workspaceId: '', eventKey: 'event', outboxEventId }, 'worker-1'),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
    await expect(
      handlers.import(
        { workspaceId, eventKey: 'event', outboxEventId: 'not-an-object-id' },
        'worker-1',
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
    expect(processing.hydrateOutbox).not.toHaveBeenCalled();
    expect(processing.handleImport).not.toHaveBeenCalled();
  });

  it('rejects a hydrated Outbox event from another workspace', async () => {
    const processing = {
      hydrateOutbox: vi.fn(async () => ({
        eventType: 'index.job.queued',
        eventKey: 'event',
        aggregateId: outboxEventId,
        payload: { jobId: outboxEventId },
        workspaceId: 'ws_other',
      })),
      handleImport: vi.fn(),
      handleQueue: vi.fn(),
    } as unknown as S06ProcessingApplication;
    const handlers = new S06JobHandlers(processing);
    await expect(
      handlers.queue(
        'knowledge-index',
        { workspaceId, eventKey: 'event', outboxEventId },
        'worker-1',
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_FORBIDDEN' } },
    });
    expect(processing.handleQueue).not.toHaveBeenCalled();
  });
});
