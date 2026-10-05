import { describe, expect, it } from 'vitest';
import {
  JOB_MODE_TO_QUEUE,
  QUEUE_NAMES,
  buildDeleteJobId,
  buildMigrationJobId,
  buildParseJobId,
  buildSyncJobId,
} from '../../src/index';

describe('job contract (12.10)', () => {
  it('stable job ids follow the frozen templates', () => {
    expect(buildParseJobId('t1', 'd1', 'c1', 3)).toBe('t1:d1:c1:parse:3');
    expect(buildDeleteJobId('t1', 'd1')).toBe('t1:d1:delete');
    expect(buildSyncJobId('t1', 'd1')).toBe('t1:d1:sync');
    expect(buildMigrationJobId('t1', 'm1', 'b1')).toBe('t1:m1:b1');
  });

  it('maps every registered job mode to a queue and forbids auto', () => {
    expect(JOB_MODE_TO_QUEUE.parse).toBe(QUEUE_NAMES.parse);
    expect(JOB_MODE_TO_QUEUE.imageParse).toBe(QUEUE_NAMES.imageParse);
    expect(JOB_MODE_TO_QUEUE.auto).toBeUndefined();
  });
});
