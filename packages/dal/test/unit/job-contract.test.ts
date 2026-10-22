import { describe, expect, it } from 'vitest';
import {
  JOB_MODE_TO_QUEUE,
  KNOWLEDGE_QUEUE_NAMES,
  QUEUE_NAMES,
  buildKnowledgeJobId,
} from '../../src/index';

describe('knowledge job contract', () => {
  it('builds a stable k_ plus 40 hex character job id', () => {
    const input = {
      kind: 'parse',
      resourceId: 'source-1',
      version: 3,
      inputHash: 'hash-1',
    };
    expect(buildKnowledgeJobId(input)).toBe(buildKnowledgeJobId(input));
    expect(buildKnowledgeJobId(input)).toMatch(/^k_[0-9a-f]{40}$/);
  });

  it('maps every registered job mode to one of exactly 13 knowledge queues', () => {
    expect(JOB_MODE_TO_QUEUE.parse).toBe(QUEUE_NAMES.parse);
    expect(JOB_MODE_TO_QUEUE.caption).toBe(QUEUE_NAMES.caption);
    expect(Object.keys(QUEUE_NAMES)).toHaveLength(13);
    expect(KNOWLEDGE_QUEUE_NAMES.every((name) => name.startsWith('knowledge-'))).toBe(true);
  });
});
