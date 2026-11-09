import type { Directory, Job, Segment, Source, Tag } from './types';

export type DetailTab = 'collectionCard' | 'dataCard' | 'test' | 'import';

export function normalizeDetailTab(value?: string): DetailTab {
  if (value === 'dataCard' || value === 'test' || value === 'import') return value;
  return 'collectionCard';
}

export function directoryPath(directories: Directory[], currentId?: string) {
  const result: Directory[] = [];
  const byId = new Map(directories.map((directory) => [directory.id, directory]));
  const visited = new Set<string>();
  let current = currentId ? byId.get(currentId) : undefined;
  while (current && !visited.has(current.id)) {
    result.unshift(current);
    visited.add(current.id);
    current = current.parentDirectoryId ? byId.get(current.parentDirectoryId) : undefined;
  }
  return result;
}

export function descendantDirectoryIds(directories: Directory[], directoryId: string): Set<string> {
  const result = new Set<string>();
  let frontier = new Set([directoryId]);
  while (frontier.size > 0) {
    const next = new Set<string>();
    for (const directory of directories) {
      if (
        directory.parentDirectoryId &&
        frontier.has(directory.parentDirectoryId) &&
        !result.has(directory.id)
      ) {
        result.add(directory.id);
        next.add(directory.id);
      }
    }
    frontier = next;
  }
  return result;
}

export function filterSourceRows(
  sources: Source[],
  input: { search: string; tagId: string; tagValue: string },
) {
  const keyword = input.search.trim().toLocaleLowerCase('zh-CN');
  return sources.filter((source) => {
    if (keyword && !(source.name ?? '').toLocaleLowerCase('zh-CN').includes(keyword)) return false;
    if (!input.tagId) return true;
    return (source.tagValues ?? []).some(
      (entry) =>
        entry.tagId === input.tagId &&
        (!input.tagValue || formatTagValueKey(entry.value) === input.tagValue),
    );
  });
}

export function formatTagValueKey(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function tagValuesForSource(source: Source, tags: Tag[]) {
  const tagById = new Map(tags.map((tag) => [tag.id, tag]));
  return (source.tagValues ?? []).map((entry) => ({
    id: entry.tagId,
    label: tagById.get(entry.tagId)?.label ?? entry.tagId,
    value: formatTagValueKey(entry.value),
  }));
}

export function sourceStatusView(status: string) {
  if (status === 'ready') return { label: '已就绪', tone: 'success' as const };
  if (status === 'failed') return { label: '训练异常', tone: 'danger' as const };
  if (status === 'partial') return { label: '部分完成', tone: 'warning' as const };
  if (status === 'parsing') return { label: '内容解析中', tone: 'info' as const };
  if (status === 'indexing') return { label: '索引中', tone: 'purple' as const };
  if (status === 'rebuilding') return { label: '重建中', tone: 'purple' as const };
  if (status === 'queued') return { label: '排队中', tone: 'warning' as const };
  if (status === 'deleting') return { label: '删除中', tone: 'warning' as const };
  if (status === 'deleted') return { label: '已删除', tone: 'neutral' as const };
  if (status === 'draft') return { label: '未开始', tone: 'neutral' as const };
  return { label: status || '未知', tone: 'neutral' as const };
}

export function sourceKindLabel(kind: Source['kind']) {
  const labels: Record<Source['kind'], string> = {
    file: '文件',
    text: '自定义文本',
    url: '网页链接',
    template: '模板',
    backup: '备份',
    api_library: 'API 文件库',
    feishu: '飞书',
    yuque: '语雀',
    dingtalk: '钉钉',
    image: '图片集合',
  };
  return labels[kind] ?? kind;
}

export function latestJobsByResource(jobs: Job[]) {
  const result = new Map<string, Job>();
  for (const job of jobs) {
    const existing = result.get(job.resourceId);
    if (!existing || Date.parse(job.updatedAt) > Date.parse(existing.updatedAt)) {
      result.set(job.resourceId, job);
    }
  }
  return result;
}

export function hasActiveSourceStatus(source: Source) {
  return ['queued', 'parsing', 'indexing', 'rebuilding'].includes(source.processingStatus);
}

export function segmentModeForSource(source?: Source) {
  if (source?.kind === 'image') return 'image' as const;
  return 'chunk' as const;
}

export function segmentDisplayContent(segment: Segment) {
  if (segment.question && segment.answer)
    return { question: segment.question, answer: segment.answer };
  return { question: segment.content || segment.question, answer: '' };
}
