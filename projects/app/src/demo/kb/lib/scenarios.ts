import { api } from './api';
import { demoFetch } from './demo-fetch';
import { rememberId } from './run-store';
import type { ScenarioRun, ScenarioStepState } from '../types';

export interface StepOutcome {
  status: 'passed' | 'failed' | 'blocked';
  detail: string;
  seq?: number;
}

export interface StepContext {
  scenarioId: string;
  stepId: string;
  state: Record<string, unknown>;
  remember: (kind: string, id: string) => void;
}

export interface ScenarioStep {
  stepId: string;
  title: string;
  run: (ctx: StepContext) => Promise<StepOutcome>;
}

export interface ScenarioDef {
  scenarioId: string;
  title: string;
  description: string;
  steps: ScenarioStep[];
}

const stamp = () => new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);

function fail(detail: string): StepOutcome {
  return { status: 'failed', detail };
}

function blocked(detail: string): StepOutcome {
  return { status: 'blocked', detail };
}

function describe(result: { entry: { status: number; code: number; messageKey?: string }; ok: boolean }): string {
  return `HTTP ${result.entry.status} · code ${result.entry.code}${
    result.entry.messageKey ? ` · ${result.entry.messageKey}` : ''
  }`;
}

async function pollTraining(collectionId: string, ctx: StepContext): Promise<StepOutcome> {
  const startedAt = Date.now();
  let delay = 1000;
  let last = 'unknown';
  while (Date.now() - startedAt < 120_000) {
    const result = await api.collectionTrainingStatus(collectionId);
    if (!result.ok) return fail(describe(result));
    const status = String(result.envelope.data?.trainingState ?? 'unknown');
    last = status;
    if (status === 'ready') {
      return { status: 'passed', detail: `trainingState=ready（${Math.round((Date.now() - startedAt) / 1000)}s）`, seq: result.entry.seq };
    }
    if (status === 'error') {
      return { status: 'failed', detail: 'trainingState=error（训练任务失败，查看 training/errors）', seq: result.entry.seq };
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(Math.round(delay * 1.5), 5000);
  }
  void ctx;
  return blocked(`训练轮询超时（120s），最后状态=${last}；可能是 Worker 未消费或 Embedding 未配置`);
}

export const SCENARIOS: ScenarioDef[] = [
  {
    scenarioId: 'S1',
    title: '空库生命周期',
    description: '创建 Dataset → 查详情 → 删除 → 查删除任务；验证事务删除与幂等。',
    steps: [
      {
        stepId: 'S1-1',
        title: '创建知识库',
        async run(ctx) {
          const name = `[DEMO] S1-${stamp()}`;
          const result = await api.createDataset({ name, type: 'dataset', embeddingModel: 'bge-m3' });
          if (!result.ok) return fail(describe(result));
          const datasetId = String(result.envelope.data?.datasetId ?? '');
          ctx.state.datasetId = datasetId;
          ctx.state.datasetName = name;
          ctx.remember('dataset', datasetId);
          return { status: 'passed', detail: `datasetId=${datasetId}`, seq: result.entry.seq };
        },
      },
      {
        stepId: 'S1-2',
        title: '查询详情',
        async run(ctx) {
          if (!ctx.state.datasetId) return blocked('缺少 datasetId');
          const result = await api.getDataset(String(ctx.state.datasetId));
          if (!result.ok) return fail(describe(result));
          return {
            status: 'passed',
            detail: `name=${result.envelope.data?.dataset?.name} collections=${result.envelope.data?.stats?.collections}`,
            seq: result.entry.seq,
          };
        },
      },
      {
        stepId: 'S1-3',
        title: '删除知识库',
        async run(ctx) {
          if (!ctx.state.datasetId) return blocked('缺少 datasetId');
          const key = `demo-s1-${Date.now()}`;
          const result = await api.deleteDataset(String(ctx.state.datasetId), key);
          ctx.state.deleteKey = key;
          if (result.entry.status !== 200) return fail(describe(result));
          ctx.state.jobId = String(result.envelope.data?.jobId ?? '');
          return { status: 'passed', detail: `jobId=${ctx.state.jobId || '（未返回）'}`, seq: result.entry.seq };
        },
      },
      {
        stepId: 'S1-4',
        title: '查询删除任务',
        async run(ctx) {
          if (!ctx.state.jobId) return blocked('删除未返回 jobId');
          const result = await api.getDeleteJob(String(ctx.state.jobId));
          if (!result.ok) return fail(describe(result));
          return {
            status: 'passed',
            detail: `state=${result.envelope.data?.state} stage=${result.envelope.data?.stage}`,
            seq: result.entry.seq,
          };
        },
      },
      {
        stepId: 'S1-5',
        title: '重复删除（幂等）',
        async run(ctx) {
          if (!ctx.state.datasetId) return blocked('缺少 datasetId');
          const result = await api.deleteDataset(String(ctx.state.datasetId), String(ctx.state.deleteKey));
          if (result.entry.status !== 200) return fail(`重复删除未返回 200：${describe(result)}`);
          return { status: 'passed', detail: '同 key 重放返回 200', seq: result.entry.seq };
        },
      },
    ],
  },
  {
    scenarioId: 'S2',
    title: '文本导入到检索',
    description: '建库 → 建 text 集合 → 轮询训练 → 数据列表 → 检索命中。',
    steps: [
      {
        stepId: 'S2-1',
        title: '创建知识库',
        async run(ctx) {
          const name = `[DEMO] S2-${stamp()}`;
          const result = await api.createDataset({ name, type: 'dataset', embeddingModel: 'bge-m3' });
          if (!result.ok) return fail(describe(result));
          const datasetId = String(result.envelope.data?.datasetId ?? '');
          ctx.state.datasetId = datasetId;
          ctx.remember('dataset', datasetId);
          return { status: 'passed', detail: `datasetId=${datasetId}`, seq: result.entry.seq };
        },
      },
      {
        stepId: 'S2-2',
        title: '创建文本集合',
        async run(ctx) {
          if (!ctx.state.datasetId) return blocked('缺少 datasetId');
          const text = [
            '验收平台验证知识库文本导入链路。',
            '这一段文本用于切分与向量化，验证检索能否命中。',
            '如果 Embedding 未配置，导入会在训练阶段失败。',
          ].join('\n');
          const result = await api.createTextCollection({ datasetId: String(ctx.state.datasetId), text });
          if (!result.ok) return fail(describe(result));
          const collectionId = String(result.envelope.data?.collectionId ?? '');
          ctx.state.collectionId = collectionId;
          ctx.remember('collection', collectionId);
          return {
            status: 'passed',
            detail: `collectionId=${collectionId} insertLen=${result.envelope.data?.insertLen}`,
            seq: result.entry.seq,
          };
        },
      },
      {
        stepId: 'S2-3',
        title: '轮询训练状态',
        async run(ctx) {
          if (!ctx.state.collectionId) return blocked('缺少 collectionId');
          return pollTraining(String(ctx.state.collectionId), ctx);
        },
      },
      {
        stepId: 'S2-4',
        title: '数据列表可见',
        async run(ctx) {
          if (!ctx.state.collectionId) return blocked('缺少 collectionId');
          const result = await api.listData({ collectionId: String(ctx.state.collectionId) });
          if (!result.ok) return fail(describe(result));
          const total = result.envelope.data?.total ?? 0;
          if (total < 1) return fail('数据列表为空（training 未产出 Data）');
          return { status: 'passed', detail: `total=${total}`, seq: result.entry.seq };
        },
      },
      {
        stepId: 'S2-5',
        title: '检索命中引用',
        async run(ctx) {
          if (!ctx.state.datasetId) return blocked('缺少 datasetId');
          const result = await api.searchTest({
            datasetId: String(ctx.state.datasetId),
            text: '向量化检索',
            limit: 5,
          });
          if (!result.ok) return fail(describe(result));
          const citations = result.envelope.data?.searchRes?.citations ?? [];
          if (citations.length === 0) {
            const stats = JSON.stringify(result.envelope.data?.searchRes?.stats ?? {});
            return fail(`检索 0 命中；stats=${stats.slice(0, 220)}`);
          }
          return { status: 'passed', detail: `citations=${citations.length}`, seq: result.entry.seq };
        },
      },
      {
        stepId: 'S2-6',
        title: '清理本场景知识库',
        async run(ctx) {
          if (!ctx.state.datasetId) return blocked('缺少 datasetId');
          const result = await api.deleteDataset(String(ctx.state.datasetId), `demo-s2-${Date.now()}`);
          if (result.entry.status !== 200) return fail(describe(result));
          return { status: 'passed', detail: '已提交删除任务', seq: result.entry.seq };
        },
      },
    ],
  },
  {
    scenarioId: 'S3',
    title: '直接插入与批量推送',
    description: 'insertData → pushData → 训练 → 列表 → 检索。',
    steps: [
      {
        stepId: 'S3-1',
        title: '创建知识库与虚拟集合',
        async run(ctx) {
          const created = await api.createDataset({
            name: `[DEMO] S3-${stamp()}`,
            type: 'dataset',
            embeddingModel: 'bge-m3',
          });
          if (!created.ok) return fail(describe(created));
          const datasetId = String(created.envelope.data?.datasetId ?? '');
          ctx.state.datasetId = datasetId;
          ctx.remember('dataset', datasetId);
          const collection = await demoFetch<{ collectionId: string }>({
            method: 'POST',
            path: '/api/core/dataset/collection/create/empty',
            body: { datasetId, name: `[DEMO] virtual-${stamp()}`, type: 'virtual' },
          });
          if (!collection.ok) return fail(describe(collection));
          const collectionId = String(collection.envelope.data?.collectionId ?? '');
          ctx.state.collectionId = collectionId;
          ctx.remember('collection', collectionId);
          return { status: 'passed', detail: `collectionId=${collectionId}`, seq: collection.entry.seq };
        },
      },
      {
        stepId: 'S3-2',
        title: '直接插入一条数据',
        async run(ctx) {
          if (!ctx.state.collectionId) return blocked('缺少 collectionId');
          const result = await api.insertData({
            collectionId: String(ctx.state.collectionId),
            q: '验收平台直接插入的问题',
            a: '验收平台直接插入的回答',
          });
          if (!result.ok) return fail(describe(result));
          return { status: 'passed', detail: `dataId=${result.envelope.data?.dataId}`, seq: result.entry.seq };
        },
      },
      {
        stepId: 'S3-3',
        title: '批量推送 2 条',
        async run(ctx) {
          if (!ctx.state.collectionId) return blocked('缺少 collectionId');
          const result = await api.pushData({
            collectionId: String(ctx.state.collectionId),
            items: [{ q: '批量推送问题一' }, { q: '批量推送问题二', a: '答案二' }],
          });
          if (!result.ok) return fail(describe(result));
          return { status: 'passed', detail: `queued=${JSON.stringify(result.envelope.data)}`, seq: result.entry.seq };
        },
      },
      {
        stepId: 'S3-4',
        title: '数据列表',
        async run(ctx) {
          if (!ctx.state.collectionId) return blocked('缺少 collectionId');
          const result = await api.listData({ collectionId: String(ctx.state.collectionId) });
          if (!result.ok) return fail(describe(result));
          return { status: 'passed', detail: `total=${result.envelope.data?.total}`, seq: result.entry.seq };
        },
      },
    ],
  },
  {
    scenarioId: 'S4',
    title: '删除与失败重试',
    description: '删除 Dataset → 任务详情 → 失败项 → 重试。',
    steps: [
      {
        stepId: 'S4-1',
        title: '创建并删除知识库',
        async run(ctx) {
          const created = await api.createDataset({
            name: `[DEMO] S4-${stamp()}`,
            type: 'dataset',
            embeddingModel: 'bge-m3',
          });
          if (!created.ok) return fail(describe(created));
          const datasetId = String(created.envelope.data?.datasetId ?? '');
          ctx.state.datasetId = datasetId;
          ctx.remember('dataset', datasetId);
          const deleted = await api.deleteDataset(datasetId, `demo-s4-${Date.now()}`);
          if (deleted.entry.status !== 200) return fail(describe(deleted));
          ctx.state.jobId = String(deleted.envelope.data?.jobId ?? '');
          return { status: 'passed', detail: `jobId=${ctx.state.jobId}`, seq: deleted.entry.seq };
        },
      },
      {
        stepId: 'S4-2',
        title: '查询失败项',
        async run(ctx) {
          if (!ctx.state.jobId) return blocked('缺少 jobId');
          const result = await api.deleteJobFailures(String(ctx.state.jobId));
          if (!result.ok) return fail(describe(result));
          return { status: 'passed', detail: `total=${result.envelope.data?.total ?? 0}`, seq: result.entry.seq };
        },
      },
      {
        stepId: 'S4-3',
        title: '重试删除任务',
        async run(ctx) {
          if (!ctx.state.jobId) return blocked('缺少 jobId');
          const result = await api.retryDeleteJob(String(ctx.state.jobId));
          if (!result.ok) return fail(describe(result));
          return { status: 'passed', detail: `state=${result.envelope.data?.state}`, seq: result.entry.seq };
        },
      },
    ],
  },
  {
    scenarioId: 'S5',
    title: '集合与标签',
    description: '创建文件夹与文本集合 → 打标签（能力不足时显式记录）。',
    steps: [
      {
        stepId: 'S5-1',
        title: '创建知识库',
        async run(ctx) {
          const created = await api.createDataset({
            name: `[DEMO] S5-${stamp()}`,
            type: 'dataset',
            embeddingModel: 'bge-m3',
          });
          if (!created.ok) return fail(describe(created));
          const datasetId = String(created.envelope.data?.datasetId ?? '');
          ctx.state.datasetId = datasetId;
          ctx.remember('dataset', datasetId);
          return { status: 'passed', detail: `datasetId=${datasetId}`, seq: created.entry.seq };
        },
      },
      {
        stepId: 'S5-2',
        title: '创建文件夹集合',
        async run(ctx) {
          if (!ctx.state.datasetId) return blocked('缺少 datasetId');
          const result = await api.createFolderCollection({
            datasetId: String(ctx.state.datasetId),
            name: `[DEMO] folder-${stamp()}`,
          });
          if (!result.ok) return fail(describe(result));
          ctx.remember('collection', String(result.envelope.data?.collectionId ?? ''));
          return { status: 'passed', detail: `collectionId=${result.envelope.data?.collectionId}`, seq: result.entry.seq };
        },
      },
      {
        stepId: 'S5-3',
        title: '列出标签',
        async run(ctx) {
          if (!ctx.state.datasetId) return blocked('缺少 datasetId');
          const result = await api.listTags(String(ctx.state.datasetId));
          if (!result.ok) return fail(describe(result));
          return { status: 'passed', detail: `total=${result.envelope.data?.total ?? 0}`, seq: result.entry.seq };
        },
      },
    ],
  },
  {
    scenarioId: 'S6',
    title: '文件与图片',
    description: 'presign → 上传 → 完成 → 图片集合（依赖 MinIO 与图片处理能力）。',
    steps: [
      {
        stepId: 'S6-1',
        title: '创建知识库',
        async run(ctx) {
          const created = await api.createDataset({
            name: `[DEMO] S6-${stamp()}`,
            type: 'dataset',
            embeddingModel: 'bge-m3',
          });
          if (!created.ok) return fail(describe(created));
          ctx.state.datasetId = String(created.envelope.data?.datasetId ?? '');
          ctx.remember('dataset', String(ctx.state.datasetId));
          return { status: 'passed', detail: `datasetId=${ctx.state.datasetId}`, seq: created.entry.seq };
        },
      },
      {
        stepId: 'S6-2',
        title: '申请上传签名',
        async run(ctx) {
          if (!ctx.state.datasetId) return blocked('缺少 datasetId');
          const result = await demoFetch<{ fileId?: string; uploadUrl?: string; key?: string }>({
            method: 'POST',
            path: '/api/core/dataset/file/presignUpload',
            body: {
              datasetId: String(ctx.state.datasetId),
              fileName: 'demo.txt',
              size: 18,
              mimeType: 'text/plain',
            },
          });
          if (!result.ok) return fail(describe(result));
          return { status: 'passed', detail: `fileId=${result.envelope.data?.fileId ?? '—'}`, seq: result.entry.seq };
        },
      },
      {
        stepId: 'S6-3',
        title: '创建图片集合',
        async run(ctx) {
          if (!ctx.state.datasetId) return blocked('缺少 datasetId');
          const result = await demoFetch<{ collectionId?: string; items?: unknown[] }>({
            method: 'POST',
            path: '/api/core/dataset/collection/create/images',
            body: {
              datasetId: String(ctx.state.datasetId),
              images: [`temp/demo/none.png`],
              trainingType: 'auto',
            },
          });
          if (!result.ok) return fail(describe(result));
          const items = (result.envelope.data?.items ?? []) as { state?: string; errorMsg?: string }[];
          const failed = items.find((item) => item.state === 'failed');
          if (failed) {
            return {
              status: 'failed',
              detail: `集合已创建，但单图处理失败：${failed.errorMsg ?? 'unknown'}`,
              seq: result.entry.seq,
            };
          }
          return { status: 'passed', detail: `items=${items.length}`, seq: result.entry.seq };
        },
      },
    ],
  },
  {
    scenarioId: 'S7',
    title: '权限快照',
    description: '读取权限快照与继承状态（单身份环境无法验证协作者变更）。',
    steps: [
      {
        stepId: 'S7-1',
        title: '创建知识库',
        async run(ctx) {
          const created = await api.createDataset({
            name: `[DEMO] S7-${stamp()}`,
            type: 'dataset',
            embeddingModel: 'bge-m3',
          });
          if (!created.ok) return fail(describe(created));
          ctx.state.datasetId = String(created.envelope.data?.datasetId ?? '');
          ctx.remember('dataset', String(ctx.state.datasetId));
          return { status: 'passed', detail: `datasetId=${ctx.state.datasetId}`, seq: created.entry.seq };
        },
      },
      {
        stepId: 'S7-2',
        title: '读取权限快照',
        async run(ctx) {
          if (!ctx.state.datasetId) return blocked('缺少 datasetId');
          const result = await api.getPermission(String(ctx.state.datasetId));
          if (!result.ok) return fail(describe(result));
          return {
            status: 'passed',
            detail: `permissionMask=${String(result.envelope.data?.permissionMask ?? '—')}`,
            seq: result.entry.seq,
          };
        },
      },
      {
        stepId: 'S7-3',
        title: '协作者列表（/proApi）',
        async run(ctx) {
          if (!ctx.state.datasetId) return blocked('缺少 datasetId');
          const result = await demoFetch<{ list?: unknown[] }>({
            method: 'GET',
            path: `/proApi/core/dataset/collaborator/list?datasetId=${encodeURIComponent(String(ctx.state.datasetId))}`,
          });
          if (!result.ok) return fail(describe(result));
          return { status: 'passed', detail: `list=${result.envelope.data?.list?.length ?? 0}`, seq: result.entry.seq };
        },
      },
    ],
  },
  {
    scenarioId: 'S8',
    title: '导入导出',
    description: '导出 Dataset（下载）→ 校验响应。',
    steps: [
      {
        stepId: 'S8-1',
        title: '创建知识库',
        async run(ctx) {
          const created = await api.createDataset({
            name: `[DEMO] S8-${stamp()}`,
            type: 'dataset',
            embeddingModel: 'bge-m3',
          });
          if (!created.ok) return fail(describe(created));
          ctx.state.datasetId = String(created.envelope.data?.datasetId ?? '');
          ctx.remember('dataset', String(ctx.state.datasetId));
          return { status: 'passed', detail: `datasetId=${ctx.state.datasetId}`, seq: created.entry.seq };
        },
      },
      {
        stepId: 'S8-2',
        title: '导出 Dataset',
        async run(ctx) {
          if (!ctx.state.datasetId) return blocked('缺少 datasetId');
          const result = await demoFetch({
            method: 'GET',
            path: `/api/core/dataset/exportAll?datasetId=${encodeURIComponent(String(ctx.state.datasetId))}`,
          });
          if (!result.ok) return fail(describe(result));
          return { status: 'passed', detail: `HTTP ${result.entry.status}`, seq: result.entry.seq };
        },
      },
    ],
  },
];

export function scenarioById(id: string): ScenarioDef | undefined {
  return SCENARIOS.find((item) => item.scenarioId === id);
}

export function emptyRun(def: ScenarioDef, baseline: { commit: string; branch: string }): ScenarioRun {
  return {
    scenarioId: def.scenarioId,
    title: def.title,
    startedAt: new Date().toISOString(),
    baseline,
    environment: {
      appUrl: typeof window === 'undefined' ? '' : window.location.origin,
      workerMode: 'all',
    },
    steps: def.steps.map((step) => ({ stepId: step.stepId, title: step.title, status: 'idle' })),
    summary: { passed: 0, failed: 0, blocked: 0 },
    createdIds: [],
  };
}

export function summarize(steps: ScenarioStepState[]): ScenarioRun['summary'] {
  return {
    passed: steps.filter((step) => step.status === 'passed').length,
    failed: steps.filter((step) => step.status === 'failed').length,
    blocked: steps.filter((step) => step.status === 'blocked').length,
  };
}

export { rememberId };
