import { describe, expect, it } from 'vitest';
import {
  buildQaDedupKey,
  dedupeQaItems,
  parseQaOutputValidated,
  validateQaItems,
} from '../../src/index';

describe('L1-B11-B-PARSE-004 output schema and source binding', () => {
  it('L1-B11-B-PARSE-004-P01 binds every accepted pair to the exact source chunk hash', () => {
    const parsed = parseQaOutputValidated(
      '[{"q":"退款需要多久？","a":"五个工作日。"},{"q":"超期怎么办？","a":"人工审核。"}]',
      'sha256:chunk-a',
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.every((item) => item.sourceChunkHash === 'sha256:chunk-a')).toBe(true);
  });

  it('L1-B11-B-PARSE-004-N01 rejects empty and structurally invalid JSON as a whole', () => {
    for (const output of [
      '',
      'not json',
      '{"q":"missing array","a":"answer"}',
      '[{"q":"","a":"answer"}]',
      '[{"q":"question","a":"   "}]',
    ]) {
      expect(parseQaOutputValidated(output, 'sha256:chunk-a').items, output).toEqual([]);
    }
  });

  it('L1-B11-B-PARSE-004-N02 retains complete items and diagnoses a malformed tail', () => {
    expect(
      parseQaOutputValidated('Q1: 完整问题\nA1: 完整答案\nQ2: 未完成问题', 'sha256:chunk-a'),
    ).toMatchObject({
      items: [{ q: '完整问题', a: '完整答案', sourceChunkHash: 'sha256:chunk-a' }],
      problems: ['text_unparsed'],
      repairCount: 1,
    });
  });

  it('L1-B11-B-PARSE-004-N03 retains valid JSON entries while reporting invalid siblings', () => {
    expect(
      validateQaItems(
        [
          { q: 'valid', a: 'answer', sourceChunkHash: 'sha256:chunk-a' },
          { q: '', a: 'invalid', sourceChunkHash: 'sha256:chunk-a' },
        ],
        'sha256:chunk-a',
      ),
    ).toMatchObject({
      valid: true,
      items: [{ q: 'valid', a: 'answer', sourceChunkHash: 'sha256:chunk-a' }],
    });
  });

  it('L1-B11-B-PARSE-004-N04 rejects source hash mismatch and oversized fields', () => {
    const result = validateQaItems(
      [
        { q: 'x'.repeat(20_001), a: 'answer', sourceChunkHash: 'sha256:other' },
        { q: 'question', a: 'y'.repeat(100_001), sourceChunkHash: 'sha256:chunk-a' },
      ],
      'sha256:chunk-a',
    );
    expect(result.valid).toBe(false);
  });

  it('L1-B11-B-PARSE-004-P02 keeps the first duplicate and never rewrites source hashes', () => {
    const key = buildQaDedupKey('退款需要多久？', '五个工作日。');
    expect(key).toMatch(/^qa:[a-f0-9]{64}$/);
    const deduped = dedupeQaItems(
      [
        { q: '退款需要多久？', a: '五个工作日。', sourceChunkHash: 'sha256:chunk-a' },
        { q: ' 退款需要多久？ ', a: '五个工作日。', sourceChunkHash: 'sha256:chunk-b' },
        { q: '超期怎么办？', a: '人工审核。', sourceChunkHash: 'sha256:chunk-b' },
      ],
      5,
    );
    expect(deduped.items).toEqual([
      { q: '退款需要多久？', a: '五个工作日。', sourceChunkHash: 'sha256:chunk-a' },
      { q: '超期怎么办？', a: '人工审核。', sourceChunkHash: 'sha256:chunk-b' },
    ]);
  });
});
