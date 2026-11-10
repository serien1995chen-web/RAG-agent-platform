import { describe, expect, it } from 'vitest';
import {
  batchDeleteConfirmation,
  breadcrumbSpacePath,
  descendantSpaceIds,
  filterAndSortSpaces,
} from '../../src/product/dataset-list-state';
import { productTokens } from '../../src/product/tokens';
import type { KnowledgeSpace } from '../../src/product/types';

function space(id: string, name: string, input: Partial<KnowledgeSpace> = {}): KnowledgeSpace {
  return {
    id,
    workspaceId: 'ws_test',
    kind: 'space',
    parentSpaceId: null,
    name,
    description: '',
    iconKey: 'book-open',
    ownershipMemberId: 'mem_owner',
    accessMode: 'workspace',
    sourceAclMode: 'inherited',
    sourcePermissionEnabled: true,
    referenceRevision: 0,
    status: 'active',
    version: 1,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
    ...input,
  };
}

describe('FastGPT product list module', () => {
  it('uses the mandated visual tokens', () => {
    expect(productTokens.colors.primary).toBe('#3370FF');
    expect(productTokens.colors.canvas).toBe('#F4F4F7');
    expect(productTokens.colors.page).toBe('#FBFBFC');
    expect(productTokens.radius.control).toBe('6px');
    expect(productTokens.radius.panel).toBe('8px');
    expect(productTokens.radius.card).toBe('12px');
    expect(productTokens.radius.page).toBe('16px');
  });

  it('L1-B01-KB-002-UI01 filters by real name, owner and type while retaining folders', () => {
    const rows = [
      space('1', '研发资料'),
      space('2', '客服资料', { ownershipMemberId: 'mem_support', iconKey: 'connector:feishu' }),
      space('3', '归档文件', { kind: 'folder', iconKey: 'folder' }),
    ];
    expect(
      filterAndSortSpaces(rows, {
        search: '',
        type: 'feishu',
        owner: '',
        sort: '-updatedAt',
      }).map((item) => item.id),
    ).toEqual(['3', '2']);
    expect(
      filterAndSortSpaces(rows, {
        search: '',
        type: 'all',
        owner: 'mem_support',
        sort: 'name',
      }).map((item) => item.id),
    ).toEqual(['2']);
  });

  it('L1-B01-KB-003-UI01 builds a real folder path and rejects descendant move targets', () => {
    const root = space('root', '根目录', { kind: 'folder', iconKey: 'folder' });
    const child = space('child', '子目录', {
      kind: 'folder',
      iconKey: 'folder',
      parentSpaceId: 'root',
    });
    const leaf = space('leaf', '知识库', { parentSpaceId: 'child' });
    const spaces = [root, child, leaf];
    expect(breadcrumbSpacePath(spaces, child).map((item) => item.name)).toEqual([
      '根目录',
      '子目录',
    ]);
    expect(descendantSpaceIds(spaces, 'root')).toEqual(new Set(['child', 'leaf']));
  });

  it('L1-B01-KB-001-UI01 uses FastGPT confirmation text for single and batch deletion', () => {
    expect(batchDeleteConfirmation([space('1', '单库')])).toBe('单库');
    expect(batchDeleteConfirmation([space('1', 'A'), space('2', 'B')])).toBe('确认删除');
  });

  it('L1-B01-KB-001-N01 keeps sibling duplicate names as independent selectable rows', () => {
    const rows = [
      space('duplicate-a', '同名知识库'),
      space('duplicate-b', '同名知识库'),
      space('different', '其他知识库'),
    ];
    expect(
      filterAndSortSpaces(rows, {
        search: '同名知识库',
        type: 'general',
        owner: '',
        sort: '-updatedAt',
      }).map((item) => item.id),
    ).toEqual(['duplicate-a', 'duplicate-b']);
    expect(batchDeleteConfirmation(rows.slice(0, 2))).toBe('确认删除');
  });
});
