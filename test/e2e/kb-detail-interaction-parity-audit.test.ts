import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, expect as playwrightExpect, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerKnowledgeModels } from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';
import { startB06aApp, type B06aAppHarness } from './b06a-harness';
import { apiHeaders, consoleCookie } from './s4-app-harness';

const root = resolve(import.meta.dirname, '../..');
const suffix = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
const workspaceId = `ws_kb_detail_parity_${suffix}`;
const memberId = `mem_kb_detail_parity_${suffix}`;
const authToken = `kb-detail-parity-${suffix}`;
const fixturePath = join(root, 'test/fixtures/kb-import-heading-scroll-matrix.md');
const fileName = `真实文件名-${suffix}.md`;
const imageName = `真实图片文件名-${suffix}.png`;
const failureName = `受控失败文件-${suffix}.md`;
const evidenceDir =
  process.env.KB_AUDIT_EVIDENCE_DIR ??
  '/mnt/c/Users/Administrator/Desktop/FastGPT知识库交互与业务一致性验收证据-20261127';

const FILE_METADATA_LABELS = [
  '集合 ID',
  '数据来源',
  '数据集名称',
  '来源大小',
  '创建时间',
  '更新时间',
  'PDF增强解析',
  '原文长度',
  '处理模式',
  '将标题加入索引',
  '图片索引',
  '自动生成补充索引',
  '分块大小',
  '索引大小',
  '集合标签',
] as const;

const IMAGE_METADATA_LABELS = [
  '集合 ID',
  '数据来源',
  '数据集名称',
  '创建时间',
  '更新时间',
  '处理模式',
  '集合标签',
] as const;

const FILE_COLUMNS = [
  '名称',
  '处理模式',
  '数据量',
  '创建/更新时间',
  '状态',
  '启用',
  '操作',
] as const;
const RETRAIN_STEPS = ['调整参数', '数据预览', '确认上传'] as const;

interface SourceView {
  id: string;
  name: string;
  kind: string;
  processingStatus: string;
  sourceVersion: number;
  segmentCount?: number;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  processingModel?: string;
  chunkSettings?: Record<string, unknown>;
  [key: string]: unknown;
}

interface PageView<T> {
  items: T[];
  pageInfo?: Record<string, unknown>;
}

interface Mismatch {
  id: string;
  area: string;
  expected: unknown;
  actual: unknown;
  impact: 'P0' | 'P1' | 'P2';
}

let app: B06aAppHarness;
let browser: Browser;
let cookie: Awaited<ReturnType<typeof consoleCookie>>;
let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
let models: ReturnType<typeof registerKnowledgeModels>;
let spaceId = '';
let fileSourceId = '';
let imageSourceId = '';
let failedSourceId = '';
let fixtureHash = '';

function sleep(ms: number) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function api<T = Record<string, unknown>>(
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: {
      ...apiHeaders({
        authToken,
        workspaceId,
        idempotencyKey: method === 'GET' ? undefined : `kb-detail-${suffix}-${randomUUID()}`,
      }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    data?: T;
    error?: { code?: string };
  };
  if (!response.ok || payload.success !== true) {
    throw new Error(
      `${method} ${path} failed: ${response.status} ${payload.error?.code ?? 'unknown'}`,
    );
  }
  return payload.data as T;
}

async function writeJson(name: string, value: unknown) {
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(join(evidenceDir, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

async function capture(page: Page, name: string) {
  await mkdir(evidenceDir, { recursive: true });
  const image = await page.screenshot({ path: join(evidenceDir, `${name}.png`) });
  await writeFile(
    join(evidenceDir, `${name}.sha256`),
    `${createHash('sha256').update(image).digest('hex')}\n`,
  );
  const metrics = await page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
        padding: style.padding,
        gap: style.gap,
        borderRadius: style.borderRadius,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        maxWidth: style.maxWidth,
        maxHeight: style.maxHeight,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
      };
    };
    const visibleText = (selector: string) =>
      Array.from(document.querySelectorAll<HTMLElement>(selector))
        .filter((element) => {
          const style = getComputedStyle(element);
          return style.display !== 'none' && style.visibility !== 'hidden';
        })
        .map((element) => element.textContent?.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    return {
      url: location.href,
      viewport: { width: innerWidth, height: innerHeight },
      document: {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        scrollHeight: document.documentElement.scrollHeight,
        clientHeight: document.documentElement.clientHeight,
      },
      layout: {
        main: rect('#kb2-main'),
        detailLayout: rect('.kb2-detail-layout'),
        detailPanel: rect('.kb2-detail-panel'),
        collectionTable: rect('.kb2-collection-table'),
        dataLayout: rect('.kb2-data-layout'),
        metadataPanel: rect('.kb2-meta-panel'),
        dataEditor: rect('.kb2-data-editor'),
        modal: rect('.kb2-modal'),
        importPage: rect('.kb2-import-page'),
        importSteps: rect('.kb2-import-steps'),
        importBody: rect('.kb2-import-body'),
        importMain: rect('.kb2-import-main'),
      },
      headers: visibleText('.kb2-collection-table th'),
      buttons: visibleText('button'),
      text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 12_000),
    };
  });
  await writeFile(
    join(evidenceDir, `${name}.metrics.json`),
    `${JSON.stringify(metrics, null, 2)}\n`,
  );
  return metrics;
}

function observeNetwork(page: Page) {
  const entries: Array<Record<string, unknown>> = [];
  page.on('response', async (response) => {
    const path = new URL(response.url()).pathname;
    if (!path.startsWith('/v1/knowledge/')) return;
    const request = response.request();
    entries.push({
      method: request.method(),
      path,
      status: response.status(),
      requestBody: request.postData() ?? null,
    });
  });
  return entries;
}

async function latestImportedSource(timeoutMs = 45_000): Promise<SourceView> {
  const deadline = Date.now() + timeoutMs;
  let latest: SourceView | null = null;
  while (Date.now() < deadline) {
    const page = await api<PageView<SourceView>>(
      `/v1/knowledge/spaces/${spaceId}/sources?limit=200&sort=-updatedAt`,
    );
    latest =
      page.items.find((source) => source.kind === 'file' && source.name.includes(suffix)) ?? null;
    if (latest?.processingStatus === 'ready') return latest;
    await sleep(500);
  }
  if (latest) return latest;
  throw new Error(`source matching suffix ${suffix} was not created`);
}

async function setModelBindings() {
  await api(`/v1/knowledge/spaces/${spaceId}/model-bindings`, 'PUT', {
    version: 1,
    bindings: [
      {
        modelType: 'llm',
        modelId: 'mock-llm-general',
        displayName: 'Mock general LLM',
        requiredCapabilities: ['chat'],
        status: 'active',
      },
      {
        modelType: 'embedding',
        modelId: 'mock-embedding-768',
        displayName: 'Mock embedding 768',
        requiredCapabilities: ['dimension:768', 'text-embedding'],
        status: 'active',
      },
    ],
  });
}

async function seedMetadataFixtures() {
  const image = await api<SourceView>(`/v1/knowledge/spaces/${spaceId}/sources`, 'POST', {
    kind: 'image',
    name: imageName,
    directoryId: null,
    searchEnabled: true,
    metadata: {},
  });
  imageSourceId = image.id;

  const failed = await api<SourceView>(`/v1/knowledge/spaces/${spaceId}/sources`, 'POST', {
    kind: 'text',
    name: failureName,
    directoryId: null,
    searchEnabled: true,
    metadata: {},
  });
  failedSourceId = failed.id;
  await models.KnowledgeSource.updateOne(
    { workspaceId, _id: failedSourceId },
    { $set: { processingStatus: 'failed' } },
  );
  await models.KnowledgeJob.create({
    workspaceId,
    knowledgeSpaceId: spaceId,
    version: 1,
    deletedAt: null,
    createdByMemberId: memberId,
    updatedByMemberId: memberId,
    kind: 'parse',
    resourceType: 'source',
    resourceId: failedSourceId,
    status: 'failed',
    priority: 0,
    idempotencyKey: `controlled-failed-${suffix}`,
    inputSnapshot: { sourceId: failedSourceId, sourceVersion: 1 },
    progress: { stage: 'parse', completed: 0, total: 1, percent: 0 },
    attempts: 1,
    maxAttempts: 3,
    attemptEpoch: 1,
    fencingToken: `controlled-${suffix}`,
    error: { code: 'KNOWLEDGE_UNSUPPORTED_CONTENT', retryable: true },
    result: null,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
}

async function importFixtureThroughUi(page: Page) {
  await page.goto(
    `${app.baseUrl}/dataset/detail?datasetId=${spaceId}&currentTab=import&source=fileLocal`,
    { waitUntil: 'networkidle' },
  );
  await page.locator('input[type="file"]').setInputFiles({
    name: fileName,
    mimeType: 'text/markdown',
    buffer: await readFile(fixturePath),
  });
  await playwrightExpect(page.getByText('上传完成', { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole('button', { name: '下一步' }).click();
  await playwrightExpect(page.getByText('数据处理方式设置', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '下一步' }).click();
  await playwrightExpect(page.getByText('文件列表', { exact: true })).toBeVisible();
  await page.locator('.kb2-local-file-row').first().click();
  await playwrightExpect(page.locator('.kb2-chunk-preview').first()).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole('button', { name: '下一步' }).click();
  await page.getByRole('button', { name: /开始上传/ }).click();
  await page.waitForURL((url) => url.searchParams.get('currentTab') === 'collectionCard', {
    timeout: 60_000,
  });
  const source = await latestImportedSource();
  fileSourceId = source.id;
  return source;
}

beforeAll(async () => {
  process.env.KB_TEST_MONGO_URI ??=
    'mongodb://127.0.0.1:27017/kb_detail_interaction_parity_20261127?replicaSet=rs0';
  process.env.KB_TEST_REDIS_URL ??= 'redis://127.0.0.1:6379/14';
  process.env.KB_TEST_PG_URL ??= 'postgresql://kb:kb_dev_password@127.0.0.1:5432/kb';
  process.env.KB_TEST_S3_ENDPOINT ??= 'http://127.0.0.1:9000';
  process.env.KB_TEST_S3_REGION ??= 'us-east-1';
  process.env.KB_TEST_S3_BUCKET ??= 'kb-test';
  process.env.KB_TEST_S3_ACCESS_KEY ??= 'minioadmin';
  process.env.KB_TEST_S3_SECRET_KEY ??= 'minioadmin';

  await mkdir(evidenceDir, { recursive: true });
  fixtureHash = createHash('sha256')
    .update(await readFile(fixturePath))
    .digest('hex');
  app = await startB06aApp({
    suffix,
    workspaceId,
    memberId,
    authToken,
    withWorker: true,
  });
  const space = await api<{ id: string }>('/v1/knowledge/spaces', 'POST', {
    kind: 'space',
    name: `知识库交互一致性验收-${suffix}`,
    description: '聚焦五组 FastGPT 交互与业务差异的隔离验收数据',
    accessMode: 'workspace',
    sourceAclMode: 'inherited',
    sourcePermissionEnabled: true,
  });
  spaceId = space.id;
  await setModelBindings();
  connection = await createKnowledgeMongoConnection(process.env.KB_TEST_MONGO_URI);
  models = registerKnowledgeModels(connection);
  await seedMetadataFixtures();
  cookie = await consoleCookie({ baseUrl: app.baseUrl, authToken, workspaceId });
  browser = await chromium.launch({ headless: true });
  await writeJson('baseline', {
    capturedAt: new Date().toISOString(),
    branch: 'codex/kb-import-parity-audit-20261126',
    head: 'c1b752032de802e52ef789e994114edf4d4639a6',
    workspaceId,
    memberId,
    spaceId,
    fixturePath,
    fixtureSha256: fixtureHash,
    fileName,
    imageName,
    failureName,
    appBaseUrl: app.baseUrl,
    note: 'Isolated audit fixtures are intentionally retained for later verification.',
  });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await app?.close();
  await connection?.close();
}, 60_000);

describe('FastGPT knowledge-base detail interaction parity audit', () => {
  it('records the five user-reported parity gaps with UI, API, DTO and visual evidence', async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
    });
    await context.addCookies([cookie]);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const network = observeNetwork(page);
    const consoleErrors: string[] = [];
    const mismatches: Mismatch[] = [];
    const observations: Record<string, unknown> = {};
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    try {
      const importedSource = await importFixtureThroughUi(page);
      observations.fileSourceApi = importedSource;

      await page.goto(
        `${app.baseUrl}/dataset/detail?datasetId=${spaceId}&currentTab=collectionCard`,
        { waitUntil: 'networkidle' },
      );
      await playwrightExpect(page.locator('.kb2-collection-table')).toBeVisible();
      const collectionMetrics = await capture(page, 'project-collection-1440');
      observations.collectionMetrics = collectionMetrics;
      const normalizedHeaders = collectionMetrics.headers.filter(
        (header) => header !== '' && header !== '全部文件',
      );
      observations.collectionHeaders = normalizedHeaders;
      if (JSON.stringify(normalizedHeaders) !== JSON.stringify(FILE_COLUMNS)) {
        mismatches.push({
          id: 'UI-COLLECTION-COLUMNS-001',
          area: '文件列表列结构',
          expected: FILE_COLUMNS,
          actual: normalizedHeaders,
          impact: 'P1',
        });
      }

      const standaloneDirectoryCount = await page.getByRole('button', { name: '新建目录' }).count();
      observations.standaloneDirectoryCount = standaloneDirectoryCount;
      if (standaloneDirectoryCount !== 0) {
        mismatches.push({
          id: 'UI-COLLECTION-DIRECTORY-ENTRY-001',
          area: '目录入口',
          expected: '文件夹仅位于“新建/导入”菜单',
          actual: `独立“新建目录”按钮数量=${standaloneDirectoryCount}`,
          impact: 'P1',
        });
      }

      await page.getByRole('button', { name: '新建 / 导入' }).click();
      const folderLocations = {
        standaloneCount: standaloneDirectoryCount,
        folderMenuItemCount: await page.getByRole('menuitem', { name: /文件夹/ }).count(),
      };
      observations.folderLocations = folderLocations;
      if (folderLocations.standaloneCount !== 0 || folderLocations.folderMenuItemCount !== 1) {
        mismatches.push({
          id: 'UI-COLLECTION-DIRECTORY-LOCATION-002',
          area: '目录信息架构',
          expected: { standalone: 0, folderMenuItem: 1 },
          actual: folderLocations,
          impact: 'P1',
        });
      }
      await page.keyboard.press('Escape');

      const rowText = await page
        .locator('tr')
        .filter({ hasText: importedSource.name })
        .first()
        .innerText();
      observations.fileRowText = rowText;
      const visibleIdInName = rowText.includes(importedSource.id);
      const fileNameMatches = importedSource.name === fileName && rowText.includes(fileName);
      if (!fileNameMatches || visibleIdInName) {
        mismatches.push({
          id: 'UI-COLLECTION-SOURCE-NAME-002',
          area: '文件名称',
          expected: { showsActualName: true, showsSourceId: false },
          actual: { fileNameMatches, visibleIdInName, rowText },
          impact: 'P1',
        });
      }

      const statusButton = page.getByRole('button', {
        name: new RegExp(`${importedSource.name} 的训练状态`),
      });
      const statusButtonCount = await statusButton.count();
      const statusButtonDisabled = statusButtonCount
        ? await statusButton.first().isDisabled()
        : null;
      observations.readyStatusButton = { count: statusButtonCount, disabled: statusButtonDisabled };
      if (statusButtonCount !== 0) {
        mismatches.push({
          id: 'UI-COLLECTION-READY-STATUS-001',
          area: '已就绪状态交互',
          expected: '已就绪状态不可点击',
          actual: { count: statusButtonCount, disabled: statusButtonDisabled },
          impact: 'P1',
        });
      }

      const errorButton = page.getByRole('button', { name: /异常列表/ });
      await playwrightExpect(errorButton).toBeVisible();
      const errorButtonText = await errorButton.innerText();
      observations.headerErrorButton = errorButtonText;
      await errorButton.click();
      await playwrightExpect(page.getByRole('dialog', { name: /训练异常列表/ })).toBeVisible();
      await page.waitForTimeout(350);
      const errorModalMetrics = await capture(page, 'project-training-status-failed-1440');
      observations.errorModalMetrics = errorModalMetrics;
      const errorModalText = await page.getByRole('dialog').innerText();
      observations.errorModalText = errorModalText;
      for (const expectedText of ['受控失败文件', 'KNOWLEDGE_UNSUPPORTED_CONTENT', '重试']) {
        if (!errorModalText.includes(expectedText)) {
          mismatches.push({
            id: `UI-TRAINING-STATUS-${expectedText}`,
            area: '状态/异常弹窗',
            expected: expectedText,
            actual: 'missing',
            impact: 'P1',
          });
        }
      }
      await page.getByRole('button', { name: '关闭弹窗' }).click();
      await page.getByRole('button', { name: /查看 受控失败文件-.* 的训练状态/ }).click();
      const stateDialog = page.getByRole('dialog', { name: '训练状态' });
      await playwrightExpect(stateDialog).toBeVisible();
      await page.waitForTimeout(350);
      const stateMetrics = await capture(page, 'project-training-state-1440');
      observations.trainingStateMetrics = stateMetrics;
      const stateText = await stateDialog.innerText();
      for (const expectedText of ['训练状态', '异常(1)', '内容解析', '向量化', '已就绪']) {
        if (!stateText.includes(expectedText)) {
          mismatches.push({
            id: `UI-TRAINING-STATE-${expectedText}`,
            area: '训练状态弹窗',
            expected: expectedText,
            actual: 'missing',
            impact: 'P1',
          });
        }
      }
      if (
        !stateMetrics.layout.modal ||
        stateMetrics.layout.modal.width < 705 ||
        stateMetrics.layout.modal.width > 719 ||
        stateMetrics.layout.modal.height < 612 ||
        stateMetrics.layout.modal.height > 628
      ) {
        mismatches.push({
          id: 'UI-TRAINING-STATE-SIZE-001',
          area: '训练状态弹窗尺寸',
          expected: '712×620px',
          actual: stateMetrics.layout.modal,
          impact: 'P1',
        });
      }
      await page.getByRole('button', { name: '关闭弹窗' }).click();

      await page.goto(
        `${app.baseUrl}/dataset/detail?datasetId=${spaceId}&currentTab=dataCard&collectionId=${fileSourceId}`,
        { waitUntil: 'networkidle' },
      );
      await playwrightExpect(page.locator('.kb2-meta-panel')).toBeVisible();
      const dataMetrics = await capture(page, 'project-file-data-metadata-1440');
      observations.fileDataMetrics = dataMetrics;
      const fileMetadataLabels = await page
        .locator('.kb2-meta-panel > .kb2-info-line > span')
        .allTextContents();
      observations.fileMetadataLabels = fileMetadataLabels;
      if (JSON.stringify(fileMetadataLabels) !== JSON.stringify(FILE_METADATA_LABELS)) {
        mismatches.push({
          id: 'BE-SOURCE-METADATA-FIELDS-001',
          area: '文件元数据',
          expected: FILE_METADATA_LABELS,
          actual: fileMetadataLabels,
          impact: 'P0',
        });
      }

      const fileSourceApi = await api<SourceView>(`/v1/knowledge/sources/${fileSourceId}`);
      observations.fileSourceDetailApi = fileSourceApi;
      const missingSourceFields = [
        'createdAt',
        'updatedAt',
        'processingModel',
        'chunkSettings',
      ].filter((field) => !(field in fileSourceApi));
      if (missingSourceFields.length > 0) {
        mismatches.push({
          id: 'BE-SOURCE-DTO-METADATA-001',
          area: '文件元数据合同',
          expected: 'Source 详情公开时间、处理模型与处理设置快照',
          actual: { missingFields: missingSourceFields, source: fileSourceApi },
          impact: 'P0',
        });
      }
      const storedSource = await models.KnowledgeSource.findOne({
        workspaceId,
        _id: fileSourceId,
      })
        .select({ createdAt: 1, updatedAt: 1, metadata: 1, parseProvider: 1 })
        .lean();
      observations.fileSourceStored = storedSource;
      if (
        storedSource?.metadata?.chunkingConfigSnapshot &&
        !fileSourceApi.chunkSettings &&
        !('chunkingConfigSnapshot' in (fileSourceApi.metadata ?? {}))
      ) {
        mismatches.push({
          id: 'BE-SOURCE-METADATA-PROJECTION-001',
          area: '元数据后端投影',
          expected: '已持久化的 chunkingConfigSnapshot 可供 Data 元数据读取',
          actual: {
            persisted: storedSource.metadata.chunkingConfigSnapshot,
            publicMetadata: fileSourceApi.metadata,
          },
          impact: 'P0',
        });
      }

      await page.getByRole('button', { name: '编辑数据块 1' }).click();
      await playwrightExpect(page.getByRole('dialog')).toBeVisible();
      await page.waitForTimeout(350);
      const editorMetrics = await capture(page, 'project-data-editor-chunk-1440');
      observations.editorMetrics = editorMetrics;
      const editorText = await page.getByRole('dialog').innerText();
      observations.editorText = editorText;
      const expectedEditorTerms = ['常规模式', 'QA 模式', '内容', '数据索引', '更新索引', '新增'];
      const missingEditorTerms = expectedEditorTerms.filter((term) => !editorText.includes(term));
      if (missingEditorTerms.length > 0) {
        mismatches.push({
          id: 'UI-DATA-EDITOR-IA-001',
          area: 'Data 编辑弹窗信息架构',
          expected: expectedEditorTerms,
          actual: { missing: missingEditorTerms, text: editorText },
          impact: 'P0',
        });
      }
      const editorModal = editorMetrics.layout.modal;
      if (
        !editorModal ||
        editorModal.width < 795 ||
        editorModal.width > 805 ||
        editorModal.height < 610 ||
        editorModal.height > 630 ||
        editorModal.borderRadius !== '10px'
      ) {
        mismatches.push({
          id: 'UI-DATA-EDITOR-SIZE-001',
          area: 'Data 编辑弹窗尺寸',
          expected: '800px 宽、约 620px 高、10px 圆角',
          actual: editorModal,
          impact: 'P0',
        });
      }
      await page.getByRole('tab', { name: 'QA 模式' }).click();
      const qaEditorMetrics = await capture(page, 'project-data-editor-qa-1440');
      observations.qaEditorMetrics = qaEditorMetrics;
      const qaEditorText = await page.getByRole('dialog').innerText();
      observations.qaEditorText = qaEditorText;
      for (const expectedText of ['问题', '答案', '更新索引', '数据索引', '新增']) {
        if (!qaEditorText.includes(expectedText)) {
          mismatches.push({
            id: `UI-DATA-EDITOR-QA-${expectedText}`,
            area: 'QA 编辑弹窗',
            expected: expectedText,
            actual: 'missing',
            impact: 'P0',
          });
        }
      }
      await page.getByRole('button', { name: '关闭弹窗' }).click();

      await page.getByRole('button', { name: '调整训练参数' }).click();
      await page.waitForURL(/currentTab=import.*source=reTraining/);
      const retrainMetrics = await capture(page, 'project-retraining-1440');
      observations.retrainMetrics = retrainMetrics;
      const retrainSteps = await page.locator('.kb2-import-step strong').allTextContents();
      const retrainText = await page.locator('.kb2-import-page').innerText();
      observations.retrainSteps = retrainSteps;
      observations.retrainText = retrainText;
      if (JSON.stringify(retrainSteps) !== JSON.stringify(RETRAIN_STEPS)) {
        mismatches.push({
          id: 'UI-RETRAIN-STEPS-001',
          area: '重训练步骤',
          expected: RETRAIN_STEPS,
          actual: retrainSteps,
          impact: 'P0',
        });
      }
      if (
        retrainText.includes('重训练能力尚未实现') ||
        retrainText.includes('后端能力未实现') ||
        !retrainText.includes('文件解析设置')
      ) {
        mismatches.push({
          id: 'BE-RETRAIN-CONFIG-001',
          area: '重训练业务闭环',
          expected: '参数回填且不显示能力占位',
          actual: retrainText.slice(0, 2_000),
          impact: 'P0',
        });
      }
      await page.getByRole('button', { name: '下一步' }).click();
      await playwrightExpect(page.locator('.kb2-chunk-preview').first()).toBeVisible({
        timeout: 60_000,
      });
      await capture(page, 'project-retraining-preview-1440');
      await page.getByRole('button', { name: '下一步' }).click();
      await playwrightExpect(page.getByText(fileName, { exact: true })).toBeVisible();
      await page.getByRole('button', { name: '确认上传', exact: true }).click();
      await page.waitForURL((url) => url.searchParams.get('currentTab') === 'collectionCard', {
        timeout: 90_000,
      });
      const retrainedSource = await latestImportedSource(90_000);
      observations.retrainedSourceId = retrainedSource.id;
      observations.previousSourceId = fileSourceId;
      if (retrainedSource.id === fileSourceId) {
        mismatches.push({
          id: 'BE-RETRAIN-SOURCE-ID-001',
          area: '重训练来源替换',
          expected: 'new source id',
          actual: fileSourceId,
          impact: 'P0',
        });
      }
      fileSourceId = retrainedSource.id;

      await page.goto(
        `${app.baseUrl}/dataset/detail?datasetId=${spaceId}&currentTab=dataCard&collectionId=${imageSourceId}`,
        { waitUntil: 'networkidle' },
      );
      await playwrightExpect(page.locator('.kb2-meta-panel')).toBeVisible();
      const imageMetrics = await capture(page, 'project-image-metadata-1440');
      observations.imageMetrics = imageMetrics;
      const imageMetadataLabels = await page
        .locator('.kb2-meta-panel > .kb2-info-line > span')
        .allTextContents();
      observations.imageMetadataLabels = imageMetadataLabels;
      const imageSourceApi = await api<SourceView>(`/v1/knowledge/sources/${imageSourceId}`);
      observations.imageSourceDetailApi = imageSourceApi;
      if (JSON.stringify(imageMetadataLabels) !== JSON.stringify(IMAGE_METADATA_LABELS)) {
        mismatches.push({
          id: 'UI-IMAGE-METADATA-001',
          area: '图片元数据',
          expected: IMAGE_METADATA_LABELS,
          actual: imageMetadataLabels,
          impact: 'P0',
        });
      }

      const openapi = JSON.parse(
        await readFile(join(root, 'packages/contracts/openapi/openapi.json'), 'utf8'),
      ) as { paths?: Record<string, unknown> };
      const retrainPaths = Object.keys(openapi.paths ?? {}).filter((path) =>
        /retrain|reTraining|re-processing|reprocess/i.test(path),
      );
      observations.retrainOpenApiPaths = retrainPaths;
      if (retrainPaths.length === 0) {
        mismatches.push({
          id: 'BE-RETRAIN-CONTRACT-MISSING-001',
          area: '重训练 API 合同',
          expected: '存在 source/collection 重训练接口及参数/预览/提交合同',
          actual: [],
          impact: 'P0',
        });
      }
    } finally {
      await writeJson('browser-observations', observations);
      await writeJson('network', network);
      await writeJson('console-errors', consoleErrors);
      await writeJson('mismatches', mismatches);
      await context.close();
    }

    expect(consoleErrors).toEqual([]);
    expect(mismatches).toEqual([]);
  }, 240_000);

  it('keeps the repaired Data layout usable at desktop and mobile widths', async () => {
    for (const width of [1200, 900, 360]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        locale: 'zh-CN',
      });
      await context.addCookies([cookie]);
      const page = await context.newPage();
      try {
        await page.goto(
          `${app.baseUrl}/dataset/detail?datasetId=${spaceId}&currentTab=dataCard&collectionId=${fileSourceId}`,
          { waitUntil: 'networkidle' },
        );
        await playwrightExpect(page.locator('.kb2-meta-panel')).toBeVisible();
        await page.getByRole('button', { name: '编辑数据块 1' }).click();
        await playwrightExpect(page.getByRole('dialog', { name: /编辑数据/ })).toBeVisible();
        const dimensions = await page.evaluate(() => {
          const modal = document.querySelector<HTMLElement>('.kb2-modal');
          const editor = document.querySelector<HTMLElement>('.kb2-data-editor');
          return {
            viewport: window.innerWidth,
            documentWidth: document.documentElement.scrollWidth,
            modal: modal
              ? {
                  width: Math.round(modal.getBoundingClientRect().width),
                  height: Math.round(modal.getBoundingClientRect().height),
                }
              : null,
            editorColumns: editor ? getComputedStyle(editor).gridTemplateColumns : null,
          };
        });
        if (
          dimensions.documentWidth > width + 1 ||
          !dimensions.modal ||
          dimensions.modal.width > width - 30 ||
          dimensions.modal.height > 880
        ) {
          throw new Error(
            `responsive layout mismatch at ${width}px: ${JSON.stringify(dimensions)}`,
          );
        }
        if (width <= 900 && dimensions.editorColumns?.trim().split(/\s+/).length !== 1) {
          throw new Error(`editor should collapse to one column at ${width}px`);
        }
        await capture(page, `project-data-editor-${width}`);
      } finally {
        await context.close();
      }
    }
  }, 120_000);
});
