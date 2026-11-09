import type { KnowledgeSpace } from './types';
import { productTypeOf } from './ui';

export type SpaceFilterType =
  | 'all'
  | 'folder'
  | 'general'
  | 'api'
  | 'feishu'
  | 'yuque'
  | 'dingtalk';

export type SpaceSort = '-updatedAt' | 'updatedAt' | '-createdAt' | 'createdAt' | 'name';

export function normalizedSpaceType(space: KnowledgeSpace): SpaceFilterType {
  if (space.kind === 'folder') return 'folder';
  return productTypeOf(space.iconKey).kind;
}

export function descendantSpaceIds(spaces: KnowledgeSpace[], ancestorId: string): Set<string> {
  const descendants = new Set<string>();
  let frontier = new Set([ancestorId]);
  while (frontier.size > 0) {
    const next = new Set<string>();
    for (const space of spaces) {
      if (space.parentSpaceId && frontier.has(space.parentSpaceId) && !descendants.has(space.id)) {
        descendants.add(space.id);
        next.add(space.id);
      }
    }
    frontier = next;
  }
  return descendants;
}

export function breadcrumbSpacePath(spaces: KnowledgeSpace[], folder?: KnowledgeSpace) {
  const result: KnowledgeSpace[] = [];
  const byId = new Map(spaces.map((space) => [space.id, space]));
  const visited = new Set<string>();
  let current = folder;
  while (current && !visited.has(current.id)) {
    result.unshift(current);
    visited.add(current.id);
    current = current.parentSpaceId ? byId.get(current.parentSpaceId) : undefined;
  }
  return result;
}

export function filterAndSortSpaces(
  spaces: KnowledgeSpace[],
  input: {
    search: string;
    type: SpaceFilterType;
    owner: string;
    sort: SpaceSort;
  },
) {
  const keyword = input.search.trim().toLocaleLowerCase('zh-CN');
  const sort = input.sort || '-updatedAt';
  return spaces
    .filter((space) => {
      if (keyword && !(space.name ?? '').toLocaleLowerCase('zh-CN').includes(keyword)) return false;
      if (input.owner && space.ownershipMemberId !== input.owner) return false;
      if (input.type !== 'all') {
        if (space.kind === 'folder') return true;
        if (normalizedSpaceType(space) !== input.type) return false;
      }
      return true;
    })
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1;
      if (sort === 'name') return (left.name ?? '').localeCompare(right.name ?? '', 'zh-CN');
      const leftTime = Date.parse(sort.includes('createdAt') ? left.createdAt : left.updatedAt);
      const rightTime = Date.parse(sort.includes('createdAt') ? right.createdAt : right.updatedAt);
      return sort.startsWith('-') ? rightTime - leftTime : leftTime - rightTime;
    });
}

export function spaceStatusView(status: string) {
  if (status === 'active') return { label: '正常', tone: 'success' as const };
  if (status === 'deleting') return { label: '删除中', tone: 'warning' as const };
  if (status === 'deleted') return { label: '已删除', tone: 'neutral' as const };
  return { label: status || '未知', tone: 'neutral' as const };
}

export function batchDeleteConfirmation(spaces: KnowledgeSpace[]) {
  return spaces.length === 1 ? (spaces[0]?.name ?? '') : '确认删除';
}
