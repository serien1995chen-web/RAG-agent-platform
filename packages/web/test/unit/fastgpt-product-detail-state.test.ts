import { describe, expect, it } from 'vitest';
import {
  directoryPath,
  descendantDirectoryIds,
  filterSourceRows,
  formatTagValueKey,
  latestJobsByResource,
  normalizeDetailTab,
  sourceStatusView,
  tagValuesForSource,
} from '../../src/product/dataset-detail-state';
import type { Directory, Job, Source, Tag } from '../../src/product/types';

function directory(id: string, name: string, parentDirectoryId: string | null): Directory {
  return {
    id,
    workspaceId: 'ws_test',
    knowledgeSpaceId: 'dataset',
    parentDirectoryId,
    name,
    path: [],
    depth: parentDirectoryId ? 1 : 0,
    aclMode: 'inherited',
    version: 1,
  };
}

function source(id: string, name: string, input: Partial<Source> = {}): Source {
  return {
    id,
    workspaceId: 'ws_test',
    knowledgeSpaceId: 'dataset',
    directoryId: null,
    kind: 'file',
    name,
    processingStatus: 'ready',
    sourceVersion: 1,
    searchEnabled: true,
    permissionState: 'inherited',
    permissionRevision: 0,
    version: 1,
    ...input,
  };
}

function tag(id: string, label: string, options: string[] | null = null): Tag {
  return {
    id,
    workspaceId: 'ws_test',
    knowledgeSpaceId: 'dataset',
    key: `tag_${id}`,
    label,
    tagType: options ? 'array' : 'string',
    options,
    required: false,
    status: 'active',
    version: 1,
  };
}

function job(resourceId: string, updatedAt: string, status = 'running'): Job {
  return {
    jobId: `job-${resourceId}-${updatedAt}`,
    workspaceId: 'ws_test',
    knowledgeSpaceId: 'dataset',
    kind: 'parse',
    status,
    priority: 1,
    attempts: 1,
    maxAttempts: 3,
    progress: { stage: 'parsing', completed: 1, total: 2, percent: 50 },
    resourceType: 'source',
    resourceId,
    version: 1,
    createdAt: updatedAt,
    updatedAt,
  };
}

describe('FastGPT product detail module', () => {
  it('normalizes unsupported detail tabs to Collection', () => {
    expect(normalizeDetailTab('info')).toBe('collectionCard');
    expect(normalizeDetailTab(undefined)).toBe('collectionCard');
    expect(normalizeDetailTab('test')).toBe('test');
    expect(normalizeDetailTab('import')).toBe('import');
  });

  it('builds directory paths and prevents cyclic move targets', () => {
    const directories = [
      directory('root', '根目录', null),
      directory('child', '子目录', 'root'),
      directory('leaf', '叶目录', 'child'),
    ];
    expect(directoryPath(directories, 'leaf').map((item) => item.name)).toEqual([
      '根目录',
      '子目录',
      '叶目录',
    ]);
    expect(descendantDirectoryIds(directories, 'root')).toEqual(new Set(['child', 'leaf']));
  });

  it('filters source names and typed tag values using real DTO fields', () => {
    const sources = [
      source('1', '客服手册', {
        tagValues: [{ tagId: 'tag-a', valueKey: 'department', value: ['support'] }],
      }),
      source('2', '销售手册', {
        tagValues: [{ tagId: 'tag-a', valueKey: 'department', value: ['sales'] }],
      }),
    ];
    expect(
      filterSourceRows(sources, {
        search: '客服',
        tagId: 'tag-a',
        tagValue: 'support',
      }).map((item) => item.id),
    ).toEqual(['1']);
  });

  it('formats tags without object placeholders and joins real labels', () => {
    const tags = [tag('tag-a', '部门', ['support'])];
    const item = source('1', '客服手册', {
      tagValues: [{ tagId: 'tag-a', valueKey: 'department', value: ['support'] }],
    });
    expect(tagValuesForSource(item, tags)).toEqual([
      { id: 'tag-a', label: '部门', value: 'support' },
    ]);
    expect(formatTagValueKey({ value: 1 })).toBe('{"value":1}');
  });

  it('selects the latest job and maps visible source states', () => {
    const jobs = [
      job('source-1', '2026-11-09T10:00:00.000Z'),
      job('source-1', '2026-11-09T10:05:00.000Z', 'failed'),
    ];
    expect(latestJobsByResource(jobs).get('source-1')?.status).toBe('failed');
    expect(sourceStatusView('ready')).toEqual({ label: '已就绪', tone: 'success' });
    expect(sourceStatusView('indexing')).toEqual({ label: '索引中', tone: 'purple' });
    expect(sourceStatusView('failed')).toEqual({ label: '训练异常', tone: 'danger' });
  });

  it('L1-B02-COL-003-UI01 四类标签显示与筛选状态保持可读并正确映射异步 Source 状态', () => {
    const tags = [
      { ...tag('tag-s', '部门'), tagType: 'string' as const, options: ['support'] },
      { ...tag('tag-n', '优先级'), tagType: 'number' as const, options: null },
      { ...tag('tag-d', '发布日期'), tagType: 'datetime' as const, options: null },
      tag('tag-a', '地区', ['cn', 'apac']),
    ];
    const item = source('1', '多类型标签来源', {
      tagValues: [
        { tagId: 'tag-s', valueKey: 'support', value: 'support' },
        { tagId: 'tag-n', valueKey: '3', value: 3 },
        { tagId: 'tag-d', valueKey: '1000', value: 1_000 },
        { tagId: 'tag-a', valueKey: 'cn', value: ['cn'] },
      ],
    });
    expect(tagValuesForSource(item, tags)).toEqual([
      { id: 'tag-s', label: '部门', value: 'support' },
      { id: 'tag-n', label: '优先级', value: '3' },
      { id: 'tag-d', label: '发布日期', value: '1000' },
      { id: 'tag-a', label: '地区', value: 'cn' },
    ]);
    expect(filterSourceRows([item], { search: '', tagId: 'tag-a', tagValue: 'cn' })).toHaveLength(
      1,
    );
    expect(sourceStatusView('queued')).toEqual({ label: '排队中', tone: 'warning' });
    expect(sourceStatusView('rebuilding')).toEqual({ label: '重建中', tone: 'purple' });
  });
});
