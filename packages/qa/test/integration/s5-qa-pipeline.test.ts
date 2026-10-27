import { describe, expect, it } from 'vitest';
import {
  buildQaDedupKey,
  dedupeQaItems,
  parseQaOutputValidated,
  repairQaOutputOnce,
  validateQaItems,
} from '../../src/index';

describe('TEST-PARSE-004-BLOCK QA validation, one repair and dedup', () => {
  it('validates source binding, required fields and size limits', () => {
    expect(
      validateQaItems(
        [
          { q: ' question ', a: ' answer ', sourceChunkHash: 'sha256:chunk' },
          { q: 'second', a: 'answer' },
        ],
        'sha256:chunk',
      ),
    ).toEqual({
      valid: true,
      items: [
        { q: 'question', a: 'answer', sourceChunkHash: 'sha256:chunk' },
        { q: 'second', a: 'answer', sourceChunkHash: 'sha256:chunk' },
      ],
    });
    expect(
      validateQaItems([{ q: '', a: 'answer', sourceChunkHash: 'other' }], 'sha256:chunk'),
    ).toMatchObject({ valid: false });
  });

  it('repairs malformed JSON once and rejects irreparable output without fabrication', () => {
    const repaired = repairQaOutputOnce('[{"q":"问题","a":"答案",},]', 'sha256:chunk');
    expect(repaired.repairCount).toBe(1);
    expect(repaired.items).toEqual([{ q: '问题', a: '答案', sourceChunkHash: 'sha256:chunk' }]);
    const failed = repairQaOutputOnce('not qa output at all', 'sha256:chunk');
    expect(failed).toMatchObject({
      items: [],
      repairCount: 1,
      problems: ['items_empty'],
    });
    expect(
      parseQaOutputValidated('[{"q":"合法","a":"答案"},{"q":"","a":"非法"}]', 'sha256:chunk'),
    ).toMatchObject({
      items: [],
      problems: ['items.1.q:empty'],
    });
  });

  it('uses the frozen dedup key and keeps the first duplicate globally', () => {
    const key = buildQaDedupKey('  问题 ', ' 答案 ');
    expect(key).toMatch(/^qa:[0-9a-f]{64}$/);
    const outcome = dedupeQaItems(
      [
        { q: '问题', a: '答案', sourceChunkHash: 'a' },
        { q: ' 问题 ', a: ' 答案 ', sourceChunkHash: 'b' },
        { q: '第二问', a: '第二答', sourceChunkHash: 'b' },
      ],
      5,
    );
    expect(outcome.items).toHaveLength(2);
    expect(outcome.duplicates).toBe(1);
  });
});
