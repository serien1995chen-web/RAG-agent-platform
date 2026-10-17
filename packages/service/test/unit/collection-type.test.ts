import { describe, expect, it } from 'vitest';
import {
  PERSISTED_COLLECTION_TYPES,
  toPersistedCollectionType,
} from '../../src/modules/collection/domain/collection-type';

/**
 * ISSUE-001：来源类型 → 持久化集合类型的唯一真源。
 * 设计文档 3.5.1 §12.8：集合类型枚举为 folder/virtual/file/link/externalFile/apiFile/images。
 */
describe('toPersistedCollectionType (ISSUE-001)', () => {
  it('maps source type text to persisted file', () => {
    expect(toPersistedCollectionType('text')).toBe('file');
  });

  it('maps source type image to persisted images', () => {
    expect(toPersistedCollectionType('image')).toBe('images');
  });

  it('passes through every persisted value unchanged', () => {
    for (const type of PERSISTED_COLLECTION_TYPES) {
      expect(toPersistedCollectionType(type)).toBe(type);
    }
  });

  it('exposes exactly the seven persisted types from the design vocabulary', () => {
    expect([...PERSISTED_COLLECTION_TYPES]).toEqual([
      'folder',
      'virtual',
      'file',
      'link',
      'externalFile',
      'apiFile',
      'images',
    ]);
  });

  it('rejects unknown source types with a structured 501001 error', () => {
    expect(() => toPersistedCollectionType('websiteDataset')).toThrowError(/501001/);
  });
});
