import { describe, expect, it } from 'vitest';
import {
  latestJobsByResource,
  segmentDisplayContent,
  segmentModeForSource,
  sourceStatusView,
} from '../../src/product/dataset-detail-state';
import type { Job, Segment, Source } from '../../src/product/types';

function segment(input: Partial<Segment> = {}): Segment {
  return {
    id: '000000000000000000000001',
    workspaceId: 'ws_b04_ui',
    knowledgeSpaceId: '000000000000000000000002',
    sourceId: '000000000000000000000003',
    searchEnabled: true,
    order: 0,
    question: '退款多久到账？',
    answer: '通常五个工作日内到账。',
    content: '退款多久到账？\n通常五个工作日内到账。',
    metadata: {},
    indexes: [],
    indexStatus: 'indexed',
    indexErrorCode: null,
    imageBlobRefId: null,
    version: 2,
    sourceVersion: 1,
    ...input,
  };
}

function source(kind: Source['kind']): Source {
  return {
    id: '000000000000000000000003',
    workspaceId: 'ws_b04_ui',
    knowledgeSpaceId: '000000000000000000000002',
    directoryId: null,
    kind,
    name: 'B04 UI source',
    processingStatus: 'ready',
    sourceVersion: 1,
    searchEnabled: true,
    permissionState: 'disabled',
    permissionRevision: 0,
    version: 1,
  };
}

function job(input: Partial<Job>): Job {
  return {
    jobId: 'job',
    workspaceId: 'ws_b04_ui',
    knowledgeSpaceId: '000000000000000000000002',
    kind: 'index',
    status: 'queued',
    priority: 5,
    attempts: 0,
    maxAttempts: 5,
    progress: { stage: 'queued', completed: 0, total: 1, percent: 0 },
    error: null,
    result: null,
    resourceType: 'segment',
    resourceId: '000000000000000000000001',
    version: 1,
    createdAt: '2026-11-12T00:00:00.000Z',
    updatedAt: '2026-11-12T00:00:00.000Z',
    ...input,
  };
}

describe('B04 product Data UI state', () => {
  it('L1-B04-DATA-001-UI01 card preserves question answer and Source mode rendering', () => {
    expect(segmentDisplayContent(segment())).toEqual({
      question: '退款多久到账？',
      answer: '通常五个工作日内到账。',
    });
    expect(
      segmentDisplayContent(
        segment({
          question: '',
          answer: '',
          content: '只有正文内容',
        }),
      ),
    ).toEqual({ question: '只有正文内容', answer: '' });
    expect(segmentModeForSource(source('image'))).toBe('image');
    expect(segmentModeForSource(source('text'))).toBe('chunk');
  });

  it('L1-B04-DATA-003-UI01 latest Job and Source status views preserve safe terminal state', () => {
    const older = job({
      jobId: 'older',
      status: 'failed',
      error: { code: 'KNOWLEDGE_MODEL_FAILED' },
      updatedAt: '2026-11-12T00:00:01.000Z',
    });
    const newer = job({
      jobId: 'newer',
      status: 'succeeded',
      updatedAt: '2026-11-12T00:00:05.000Z',
    });
    expect(latestJobsByResource([newer, older]).get(older.resourceId)).toMatchObject({
      jobId: 'newer',
      status: 'succeeded',
    });
    expect(sourceStatusView('ready')).toEqual({ label: '已就绪', tone: 'success' });
    expect(sourceStatusView('failed')).toEqual({ label: '训练异常', tone: 'danger' });
  });
});
