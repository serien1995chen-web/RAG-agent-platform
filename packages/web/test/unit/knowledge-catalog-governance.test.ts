import { describe, expect, it } from 'vitest';
import { messages } from '../../src/i18n/messages';
import { knowledgeQueryKeys } from '../../src/query/query-keys';

describe('S3 catalog governance UI contract', () => {
  it('provides localized move, partial, export and reference states', () => {
    for (const key of [
      'governance.moveTarget',
      'governance.batchPartial',
      'governance.exportSpace',
      'governance.downloadExport',
      'governance.references',
      'governance.noReferences',
    ] as const) {
      expect(messages['zh-CN'][key]).toBeTruthy();
      expect(messages.en[key]).toBeTruthy();
    }
  });

  it('scopes reference queries by Space', () => {
    expect(knowledgeQueryKeys.spaces.references('space-a')).not.toEqual(
      knowledgeQueryKeys.spaces.references('space-b'),
    );
  });
});
