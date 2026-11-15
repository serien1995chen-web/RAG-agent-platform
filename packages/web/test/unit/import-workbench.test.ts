import { describe, expect, it } from 'vitest';
import {
  IMPORT_SOURCE_KINDS,
  connectorProviderForKind,
  splitIds,
  toggleIdSelection,
} from '../../src/components/import-workbench';

describe('S4 import workbench contract', () => {
  it('exposes every S4 import kind without S5 parser controls', () => {
    expect(IMPORT_SOURCE_KINDS).toEqual([
      'files',
      'text',
      'url',
      'template',
      'backup',
      'api_library',
      'feishu',
      'yuque',
      'dingtalk',
    ]);
    expect(IMPORT_SOURCE_KINDS).not.toContain('model');
    expect(IMPORT_SOURCE_KINDS).not.toContain('ocr');
  });

  it('normalizes comma/space-separated source ids without inventing values', () => {
    expect(splitIds('file:1, file:2\nfile:3')).toEqual(['file:1', 'file:2', 'file:3']);
    expect(splitIds('  ')).toEqual([]);
  });

  it('ACC-UI-05 binds catalog/import provider to the selected connector kind', () => {
    expect(connectorProviderForKind('feishu')).toBe('feishu');
    expect(connectorProviderForKind('yuque')).toBe('yuque');
    expect(connectorProviderForKind('dingtalk')).toBe('dingtalk');
    expect(connectorProviderForKind('api_library')).toBeNull();
    expect(connectorProviderForKind('text')).toBeNull();
  });

  it('L1-B09-ING-006-P01/C01 keeps stable ids when catalog names refresh', () => {
    expect(toggleIdSelection('', 'file:1', true)).toBe('file:1');
    expect(toggleIdSelection('file:1', 'file:2', true)).toBe('file:1, file:2');
    expect(toggleIdSelection('file:1, file:2', 'file:1', false)).toBe('file:2');
    expect(toggleIdSelection('doc:1', 'doc:1', true)).toBe('doc:1');
    const selectedBeforeRefresh = 'file:1, file:2';
    const refreshedCatalog = [
      { id: 'file:1', name: 'Renamed one', type: 'document' },
      { id: 'file:2', name: 'Renamed two', type: 'document' },
    ];
    expect(
      refreshedCatalog.filter((item) => splitIds(selectedBeforeRefresh).includes(item.id)),
    ).toEqual(refreshedCatalog);
  });
});
