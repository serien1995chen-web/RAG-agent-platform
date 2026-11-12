'use client';

import {
  AddIcon,
  AttachmentIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  ExternalLinkIcon,
  LinkIcon,
  TimeIcon,
  WarningIcon,
} from '@chakra-ui/icons';
import { Spinner } from '@chakra-ui/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { S7MarkdownRenderer } from '../components/s7-markdown-renderer';
import {
  apiLibraryCatalog,
  connectorCatalog,
  importApiLibrary,
  importBackup,
  importConnector,
  importFiles,
  importTemplate,
  importText,
  importUrl,
  previewImportText,
  productApi,
  productErrorView,
} from './api';
import {
  ProductButton,
  ProductEmpty,
  ProductError,
  ProductField,
  ProductIconButton,
  ProductInput,
  ProductPage,
  ProductPageHeader,
  ProductSelect,
  ProductTextarea,
  ProductTypeIcon,
  StatusTag,
  useProductToast,
} from './ui';
import type { CatalogItem, Directory, Job } from './types';
import { knowledgeMultipartUpload, type KnowledgeFileUploadState } from '../client/file-upload';

type ImportKind =
  | 'local'
  | 'text'
  | 'url'
  | 'api'
  | 'feishu'
  | 'yuque'
  | 'dingtalk'
  | 'image'
  | 'template'
  | 'backup'
  | 'retraining';

interface ImportedUpload {
  rowId: string;
  id: string;
  name: string;
  progress: number;
  phase: KnowledgeFileUploadState['phase'];
  error: unknown;
}

const IMPORT_OPTIONS: Array<{
  kind: ImportKind;
  title: string;
  description: string;
  icon: typeof AttachmentIcon;
}> = [
  {
    kind: 'local',
    title: '本地文件',
    description: '上传并解析 PDF、Word、文本等文件',
    icon: AttachmentIcon,
  },
  { kind: 'text', title: '自定义文本', description: '直接粘贴文本并配置切分', icon: AddIcon },
  { kind: 'url', title: '网页链接', description: '抓取指定网页内容', icon: LinkIcon },
  {
    kind: 'api',
    title: 'API 文件库',
    description: '从兼容 API 目录选择文件',
    icon: ExternalLinkIcon,
  },
  { kind: 'feishu', title: '飞书', description: '从已连接的飞书目录导入', icon: ExternalLinkIcon },
  { kind: 'yuque', title: '语雀', description: '从已连接的语雀目录导入', icon: ExternalLinkIcon },
  {
    kind: 'dingtalk',
    title: '钉钉',
    description: '从已连接的钉钉目录导入',
    icon: ExternalLinkIcon,
  },
  { kind: 'image', title: '图片集合', description: '上传图片并建立图片知识', icon: AttachmentIcon },
  {
    kind: 'template',
    title: '模板导入',
    description: '导入 CSV / XLSX 模板',
    icon: AttachmentIcon,
  },
  { kind: 'backup', title: '备份导入', description: '导入并处理冲突策略', icon: AttachmentIcon },
  {
    kind: 'retraining',
    title: '重训练',
    description: '调整当前 Source 的训练参数',
    icon: TimeIcon,
  },
];

const STEP_LABELS = ['选择来源', '参数设置', '数据预览', '确认导入'] as const;

export function ImportWorkspace(props: {
  spaceId: string;
  datasetName: string;
  initialDirectoryId?: string;
  initialSource?: string;
  collectionId?: string;
  initialJobId?: string;
  onExit: () => void;
  onImported: () => void;
  onJobStarted?: (jobId: string) => void;
}) {
  const toast = useProductToast();
  const queryClient = useQueryClient();
  const initialKind = normalizeImportKind(props.initialSource);
  const [kind, setKind] = useState<ImportKind>(initialKind);
  const [step, setStep] = useState(props.initialJobId ? 3 : initialKind === 'retraining' ? 1 : 0);
  const [directoryId, setDirectoryId] = useState(props.initialDirectoryId ?? '');
  const [parseProvider, setParseProvider] = useState('liteparse');
  const [trainingType, setTrainingType] = useState<'chunk' | 'qa' | 'imageParse'>(
    initialKind === 'image' ? 'imageParse' : 'chunk',
  );
  const [chunkSettingMode, setChunkSettingMode] = useState<'auto' | 'custom'>('auto');
  const [chunkSize, setChunkSize] = useState('1000');
  const [chunkSplitMode, setChunkSplitMode] = useState<'paragraph' | 'size' | 'char'>('paragraph');
  const [uploaded, setUploaded] = useState<ImportedUpload[]>([]);
  const [uploading, setUploading] = useState(false);
  const uploadControllers = useRef(new Map<string, AbortController>());
  const uploadFilesByRow = useRef(new Map<string, File>());
  const [textName, setTextName] = useState('');
  const [textBody, setTextBody] = useState('');
  const [url, setUrl] = useState('');
  const [selector, setSelector] = useState('body');
  const [dryRun, setDryRun] = useState(false);
  const [conflictStrategy, setConflictStrategy] = useState<'fail' | 'skip' | 'overwrite'>('fail');
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [apiAuthorization, setApiAuthorization] = useState('');
  const [apiParentId, setApiParentId] = useState('');
  const [apiCatalog, setApiCatalog] = useState<CatalogItem[]>([]);
  const [apiSelected, setApiSelected] = useState<string[]>([]);
  const [connectorRootId, setConnectorRootId] = useState('');
  const [connectorItems, setConnectorItems] = useState<CatalogItem[]>([]);
  const [connectorSelected, setConnectorSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [jobId, setJobId] = useState(props.initialJobId ?? '');
  const [submitError, setSubmitError] = useState<unknown>(null);

  const directoriesQuery = useQuery<Directory[]>({
    queryKey: ['kb-product', 'import-directories', props.spaceId],
    queryFn: () => productApi.listDirectories(props.spaceId),
  });
  const jobQuery = useQuery<Job>({
    queryKey: ['kb-product', 'import-job', jobId],
    queryFn: () => productApi.getJob(jobId),
    enabled: Boolean(jobId),
    refetchInterval: (data) =>
      data && !['succeeded', 'failed', 'cancelled', 'dead_letter'].includes(data.status)
        ? 5_000
        : false,
    refetchIntervalInBackground: false,
  });
  const chunking = useMemo(
    () => ({
      trainingType,
      chunkSettingMode,
      chunkSplitMode,
      ...(chunkSettingMode === 'custom' ? { chunkSize: Number(chunkSize) || 1 } : {}),
    }),
    [chunkSettingMode, chunkSize, chunkSplitMode, trainingType],
  );
  const previewQuery = useQuery({
    queryKey: [
      'kb-product',
      'import-preview',
      props.spaceId,
      textName,
      textBody,
      directoryId,
      chunking,
    ],
    queryFn: () =>
      previewImportText(props.spaceId, {
        name: textName.trim(),
        text: textBody,
        directoryId: directoryId || null,
        chunking,
      }),
    enabled: step === 2 && kind === 'text' && Boolean(textName.trim()) && Boolean(textBody.trim()),
  });

  const activeOption = IMPORT_OPTIONS.find((option) => option.kind === kind)!;
  const completedUploads = uploaded.filter(
    (item) => item.phase === 'completed' && Boolean(item.id),
  );
  const uploadsReady =
    (['local', 'image'].includes(kind) && completedUploads.length > 0) ||
    (['template', 'backup'].includes(kind) && completedUploads.length === 1) ||
    (kind === 'text' && Boolean(textName.trim()) && Boolean(textBody.trim())) ||
    (kind === 'url' && Boolean(url.trim())) ||
    (kind === 'api' && apiSelected.length > 0) ||
    (['feishu', 'yuque', 'dingtalk'].includes(kind) && connectorSelected.length > 0) ||
    kind === 'retraining';

  const chooseKind = (next: ImportKind) => {
    setKind(next);
    setStep(0);
    setError(null);
    setJobId('');
    setSubmitError(null);
    setUploaded([]);
    setApiCatalog([]);
    setApiSelected([]);
    setApiParentId('');
    setConnectorRootId('');
    setConnectorItems([]);
    setConnectorSelected([]);
    setTrainingType(next === 'image' ? 'imageParse' : 'chunk');
  };

  const uploadOne = async (rowId: string, file: File) => {
    const controller = new AbortController();
    uploadControllers.current.set(rowId, controller);
    setUploading(true);
    try {
      let uploadId = '';
      await knowledgeMultipartUpload(file, {
        knowledgeSpaceId: props.spaceId,
        signal: controller.signal,
        onState: (state) => {
          if (state.uploadId) uploadId = state.uploadId;
          setUploaded((current) =>
            current.map((item) =>
              item.rowId === rowId
                ? {
                    ...item,
                    id: uploadId || item.id,
                    progress: state.progress,
                    phase: state.phase,
                    error: state.error,
                  }
                : item,
            ),
          );
        },
      });
      if (!uploadId) throw new Error('上传完成但未返回 uploadId');
      setUploaded((current) =>
        current.map((item) =>
          item.rowId === rowId
            ? {
                ...item,
                id: uploadId,
                progress: 100,
                phase: 'completed',
                error: null,
              }
            : item,
        ),
      );
    } catch (caught) {
      const aborted =
        controller.signal.aborted ||
        (caught instanceof DOMException && caught.name === 'AbortError');
      setUploaded((current) =>
        current.map((item) =>
          item.rowId === rowId
            ? {
                ...item,
                phase: aborted ? 'aborted' : 'error',
                error: aborted ? null : caught,
              }
            : item,
        ),
      );
    } finally {
      uploadControllers.current.delete(rowId);
      setUploading(uploadControllers.current.size > 0);
    }
  };

  const uploadFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    const rows = Array.from(files).map((file) => ({
      rowId: globalThis.crypto.randomUUID(),
      file,
    }));
    for (const row of rows) uploadFilesByRow.current.set(row.rowId, row.file);
    setUploaded((current) => [
      ...current,
      ...rows.map(({ rowId, file }) => ({
        rowId,
        id: '',
        name: file.name,
        progress: 0,
        phase: 'initializing' as const,
        error: null,
      })),
    ]);
    for (const row of rows) {
      await uploadOne(row.rowId, row.file);
    }
  };

  const retryUpload = async (item: ImportedUpload) => {
    const file = uploadFilesByRow.current.get(item.rowId);
    if (!file) return;
    setUploaded((current) =>
      current.map((row) =>
        row.rowId === item.rowId
          ? { ...row, id: '', progress: 0, phase: 'initializing', error: null }
          : row,
      ),
    );
    await uploadOne(item.rowId, file);
  };

  const cancelUpload = (rowId: string) => {
    uploadControllers.current.get(rowId)?.abort();
  };

  const removeUpload = (rowId: string) => {
    uploadFilesByRow.current.delete(rowId);
    setUploaded((current) => current.filter((item) => item.rowId !== rowId));
  };

  const cancelAllUploads = () => {
    for (const controller of uploadControllers.current.values()) controller.abort();
  };

  const browseApi = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiLibraryCatalog(props.spaceId, {
        config: customApiConfig(apiBaseUrl),
        credentials: customApiCredentials(apiAuthorization),
        parentId: apiParentId,
      });
      setApiCatalog(result.items);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const browseConnector = async () => {
    if (!isConnectorKind(kind)) return;
    setBusy(true);
    setError(null);
    try {
      const result = await connectorCatalog(props.spaceId, kind, {
        rootId: connectorRootId,
      });
      setConnectorItems(result.items);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setSubmitError(null);
    try {
      let job: Job;
      if (kind === 'local' || kind === 'image') {
        job = await importFiles(props.spaceId, {
          uploadIds: completedUploads.map((item) => item.id),
          directoryId: directoryId || null,
          parseProvider,
          chunking,
        });
      } else if (kind === 'text') {
        job = await importText(props.spaceId, {
          name: textName.trim(),
          text: textBody,
          directoryId: directoryId || null,
          chunking,
        });
      } else if (kind === 'url') {
        job = await importUrl(props.spaceId, {
          url,
          selector,
          directoryId: directoryId || null,
        });
      } else if (kind === 'template') {
        job = await importTemplate(props.spaceId, {
          uploadId: completedUploads[0]!.id,
          directoryId: directoryId || null,
        });
      } else if (kind === 'backup') {
        job = await importBackup(props.spaceId, {
          uploadId: completedUploads[0]!.id,
          directoryId: directoryId || null,
          dryRun,
          conflictStrategy,
        });
      } else if (kind === 'api') {
        job = await importApiLibrary(props.spaceId, {
          config: customApiConfig(apiBaseUrl),
          credentials: customApiCredentials(apiAuthorization),
          fileIds: apiSelected,
          directoryId: directoryId || null,
        });
      } else if (isConnectorKind(kind)) {
        job = await importConnector(props.spaceId, kind, {
          externalIds: connectorSelected,
          directoryId: directoryId || null,
        });
      } else {
        throw new Error('当前后端没有重训练接口，能力尚未实现。');
      }
      setJobId(job.jobId);
      setStep(3);
      props.onJobStarted?.(job.jobId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['kb-product', 'sources', props.spaceId] }),
        queryClient.invalidateQueries({ queryKey: ['kb-product', 'jobs', props.spaceId] }),
      ]);
      props.onImported();
      toast.success('导入任务已提交');
    } catch (caught) {
      setSubmitError(caught);
    } finally {
      setBusy(false);
    }
  };

  const preview = previewSummary({
    kind,
    uploaded: completedUploads,
    textName,
    textBody,
    url,
    apiSelected,
    connectorSelected,
    collectionId: props.collectionId,
  });
  const previewReady =
    step !== 2 ||
    kind !== 'text' ||
    (!previewQuery.isLoading &&
      !previewQuery.error &&
      Boolean(previewQuery.data && previewQuery.data.totalChunks > 0));

  return (
    <ProductPage className="kb2-import-page">
      <ProductPageHeader
        title="新建 / 导入"
        description={`导入到 ${props.datasetName}`}
        actions={
          <ProductButton onClick={props.onExit}>
            <ChevronLeftIcon boxSize={3.5} />
            返回 Collection
          </ProductButton>
        }
      />
      <div className="kb2-import-steps" aria-label="导入步骤">
        {STEP_LABELS.map((label, index) => (
          <div
            key={label}
            className={`kb2-import-step${step === index ? ' is-current' : ''}${step > index ? ' is-complete' : ''}`}
            aria-current={step === index ? 'step' : undefined}
          >
            <span>{step > index ? <CheckIcon /> : index + 1}</span>
            <strong>{label}</strong>
          </div>
        ))}
      </div>
      <ProductError error={error} />

      <div className="kb2-import-body">
        <aside className="kb2-import-summary">
          <div className="kb2-import-summary__head">
            <ProductTypeIcon kind={activeOption.kind === 'api' ? 'api' : 'general'} />
            <div>
              <strong>{activeOption.title}</strong>
              <span>{activeOption.description}</span>
            </div>
          </div>
          <div className="kb2-info-line">
            <span>目标知识库</span>
            <strong>{props.datasetName}</strong>
          </div>
          <ProductField label="目标目录">
            <ProductSelect
              value={directoryId}
              onChange={(event) => setDirectoryId(event.target.value)}
            >
              <option value="">知识库根目录</option>
              {(directoriesQuery.data ?? []).map((directory) => (
                <option key={directory.id} value={directory.id}>
                  {directory.name}
                </option>
              ))}
            </ProductSelect>
          </ProductField>
        </aside>

        <main className="kb2-import-main">
          {step === 0 ? (
            <div className="kb2-import-source-grid" role="group" aria-label="导入来源">
              {IMPORT_OPTIONS.map((option) => {
                const Icon = option.icon;
                return (
                  <button
                    key={option.kind}
                    type="button"
                    className={`kb2-import-source${kind === option.kind ? ' is-selected' : ''}`}
                    onClick={() => chooseKind(option.kind)}
                  >
                    <span>
                      <Icon boxSize={4} />
                    </span>
                    <strong>{option.title}</strong>
                    <small>{option.description}</small>
                  </button>
                );
              })}
            </div>
          ) : null}

          {step === 1 ? (
            <div className="kb2-import-form">
              {['local', 'image', 'template', 'backup'].includes(kind) ? (
                <label className="kb2-upload-zone">
                  <input
                    type="file"
                    multiple={kind !== 'template' && kind !== 'backup'}
                    accept={
                      kind === 'image'
                        ? 'image/jpeg,image/png,image/webp'
                        : kind === 'template' || kind === 'backup'
                          ? '.csv,.xlsx'
                          : undefined
                    }
                    onChange={(event) => void uploadFiles(event.target.files)}
                    disabled={uploading}
                  />
                  <AttachmentIcon boxSize={7} />
                  <strong>{uploading ? '正在上传' : '选择或拖放文件'}</strong>
                  <span>
                    {kind === 'template' || kind === 'backup'
                      ? '支持 CSV、XLSX'
                      : '文件将直接上传到知识库服务，不使用本地模拟结果'}
                  </span>
                </label>
              ) : null}

              {uploaded.length > 0 ? (
                <div className="kb2-upload-list">
                  {uploaded.map((item) => {
                    const errorView = item.error ? productErrorView(item.error) : null;
                    const active = ['initializing', 'uploading', 'completing'].includes(item.phase);
                    return (
                      <div
                        className={`kb2-upload-row${item.phase === 'error' ? ' kb2-upload-row--error' : ''}`}
                        key={item.rowId}
                        aria-label={`上传文件 ${item.name}`}
                      >
                        <span>
                          <strong>{item.name}</strong>
                          <small className="kb2-upload-row__status">
                            {errorView
                              ? `${errorView.message} · ${errorView.code}${
                                  errorView.traceId ? ` · Trace ${errorView.traceId}` : ''
                                }`
                              : item.phase}
                          </small>
                        </span>
                        <div className="kb2-progress-track">
                          <span style={{ width: `${item.progress}%` }} />
                        </div>
                        <div className="kb2-upload-row__actions">
                          {active ? (
                            <ProductButton
                              size="sm"
                              tone="danger"
                              aria-label={`取消上传 ${item.name}`}
                              onClick={() => cancelUpload(item.rowId)}
                            >
                              取消
                            </ProductButton>
                          ) : item.phase === 'error' ? (
                            <ProductButton
                              size="sm"
                              tone="secondary"
                              onClick={() => void retryUpload(item)}
                            >
                              重试
                            </ProductButton>
                          ) : null}
                          <ProductIconButton
                            label={`移除 ${item.name}`}
                            tone="neutral"
                            onClick={() => removeUpload(item.rowId)}
                          >
                            <CloseIcon boxSize={3} />
                          </ProductIconButton>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}
              {uploading ? (
                <ProductButton size="sm" tone="danger" onClick={cancelAllUploads}>
                  取消上传
                </ProductButton>
              ) : null}

              {kind === 'text' ? (
                <div className="kb2-form-grid">
                  <ProductField label="名称">
                    <ProductInput
                      value={textName}
                      onChange={(event) => setTextName(event.target.value)}
                    />
                  </ProductField>
                  <div className="kb2-form-grid__full">
                    <ProductField label="文本内容">
                      <ProductTextarea
                        value={textBody}
                        onChange={(event) => setTextBody(event.target.value)}
                        rows={10}
                      />
                    </ProductField>
                  </div>
                </div>
              ) : null}

              {kind === 'url' ? (
                <div className="kb2-form-grid">
                  <ProductField label="网页地址">
                    <ProductInput
                      type="url"
                      value={url}
                      onChange={(event) => setUrl(event.target.value)}
                      placeholder="https://example.com/page"
                    />
                  </ProductField>
                  <ProductField label="内容选择器" hint="默认抓取 body">
                    <ProductInput
                      value={selector}
                      onChange={(event) => setSelector(event.target.value)}
                    />
                  </ProductField>
                </div>
              ) : null}

              {kind === 'api' ? (
                <div className="kb2-import-connect">
                  <div className="kb2-form-grid">
                    <ProductField label="API 基础地址">
                      <ProductInput
                        type="url"
                        value={apiBaseUrl}
                        onChange={(event) => setApiBaseUrl(event.target.value)}
                      />
                    </ProductField>
                    <ProductField label="访问令牌">
                      <ProductInput
                        type="password"
                        autoComplete="off"
                        value={apiAuthorization}
                        onChange={(event) => setApiAuthorization(event.target.value)}
                      />
                    </ProductField>
                    <ProductField label="父目录 ID">
                      <ProductInput
                        value={apiParentId}
                        onChange={(event) => setApiParentId(event.target.value)}
                      />
                    </ProductField>
                  </div>
                  <ProductButton busy={busy} onClick={() => void browseApi()}>
                    读取 API 目录
                  </ProductButton>
                  <CatalogSelector
                    items={apiCatalog}
                    selected={apiSelected}
                    onSelect={setApiSelected}
                    onEnterDirectory={(id) => {
                      setApiParentId(id);
                      void browseApi();
                    }}
                  />
                </div>
              ) : null}

              {isConnectorKind(kind) ? (
                <div className="kb2-import-connect">
                  <ProductField label="根目录 ID">
                    <ProductInput
                      value={connectorRootId}
                      onChange={(event) => setConnectorRootId(event.target.value)}
                    />
                  </ProductField>
                  <ProductButton busy={busy} onClick={() => void browseConnector()}>
                    读取连接器目录
                  </ProductButton>
                  <CatalogSelector
                    items={connectorItems}
                    selected={connectorSelected}
                    onSelect={setConnectorSelected}
                    onEnterDirectory={() => undefined}
                  />
                </div>
              ) : null}

              {kind === 'backup' ? (
                <div className="kb2-form-grid">
                  <ProductField label="冲突策略">
                    <ProductSelect
                      value={conflictStrategy}
                      onChange={(event) =>
                        setConflictStrategy(event.target.value as 'fail' | 'skip' | 'overwrite')
                      }
                    >
                      <option value="fail">遇冲突失败</option>
                      <option value="skip">跳过冲突</option>
                      <option value="overwrite">覆盖冲突</option>
                    </ProductSelect>
                  </ProductField>
                  <label className="kb2-checkbox-row">
                    <input
                      type="checkbox"
                      checked={dryRun}
                      onChange={(event) => setDryRun(event.target.checked)}
                    />
                    <span>仅检查，不写入数据</span>
                  </label>
                </div>
              ) : null}

              {kind !== 'url' && kind !== 'api' && !isConnectorKind(kind) ? (
                <div className="kb2-import-settings">
                  <h3>训练参数</h3>
                  <div className="kb2-form-grid">
                    <ProductField label="解析器">
                      <ProductSelect
                        value={parseProvider}
                        onChange={(event) => setParseProvider(event.target.value)}
                      >
                        <option value="liteparse">LiteParse</option>
                        <option value="sangfor">Sangfor</option>
                        <option value="somark">Somark</option>
                        <option value="textin">TextIn</option>
                        <option value="doc2x">doc2x</option>
                      </ProductSelect>
                    </ProductField>
                    <ProductField label="训练类型">
                      <ProductSelect
                        value={trainingType}
                        onChange={(event) =>
                          setTrainingType(event.target.value as typeof trainingType)
                        }
                      >
                        <option value="chunk">分段</option>
                        <option value="qa">问答对</option>
                        {kind === 'image' ? <option value="imageParse">图片解析</option> : null}
                      </ProductSelect>
                    </ProductField>
                    <ProductField label="切分方式">
                      <ProductSelect
                        value={chunkSettingMode}
                        onChange={(event) =>
                          setChunkSettingMode(event.target.value as typeof chunkSettingMode)
                        }
                      >
                        <option value="auto">自动</option>
                        <option value="custom">自定义</option>
                      </ProductSelect>
                    </ProductField>
                    {chunkSettingMode === 'custom' ? (
                      <>
                        <ProductField label="分块大小">
                          <ProductInput
                            type="number"
                            min={64}
                            max={8000}
                            value={chunkSize}
                            onChange={(event) => setChunkSize(event.target.value)}
                          />
                        </ProductField>
                        <ProductField label="切分模式">
                          <ProductSelect
                            value={chunkSplitMode}
                            onChange={(event) =>
                              setChunkSplitMode(event.target.value as typeof chunkSplitMode)
                            }
                          >
                            <option value="paragraph">按段落</option>
                            <option value="size">按长度</option>
                            <option value="char">按字符</option>
                          </ProductSelect>
                        </ProductField>
                      </>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {kind === 'retraining' ? (
                <ProductEmpty
                  title="重训练能力尚未实现"
                  description="当前后端没有导入前的重训练预览或参数更新接口。页面保留完整入口，不会伪造重训练任务。"
                />
              ) : null}
            </div>
          ) : null}

          {step === 2 ? (
            <div className="kb2-import-preview">
              <div className="kb2-import-preview__header">
                <CheckIcon boxSize={5} />
                <div>
                  <h3>{preview.title}</h3>
                  <p>{preview.description}</p>
                </div>
              </div>
              <div className="kb2-info-group">
                {preview.rows.map((row) => (
                  <InfoRow key={row.label} label={row.label} value={row.value} />
                ))}
              </div>
              {kind === 'retraining' ? (
                <div className="kb2-error-panel" role="alert">
                  <WarningIcon boxSize={4} />
                  <div>
                    <strong>后端能力未实现</strong>
                    <span>未提交任何重训练请求。</span>
                  </div>
                </div>
              ) : kind === 'text' ? (
                <section aria-label="文本分块预览">
                  <ProductError
                    error={previewQuery.error}
                    onRetry={() => void previewQuery.refetch()}
                  />
                  {previewQuery.isLoading ? (
                    <div className="kb2-center-state">
                      <Spinner size="sm" /> 正在生成真实分块预览…
                    </div>
                  ) : previewQuery.data ? (
                    <>
                      <div className="kb2-info-group">
                        <InfoRow label="分块数量" value={String(previewQuery.data.totalChunks)} />
                        <InfoRow label="内容哈希" value={previewQuery.data.contentHash} />
                      </div>
                      <div className="kb2-chunk-preview-list">
                        {previewQuery.data.chunks.map((chunk) => (
                          <article className="kb2-chunk-preview" key={chunk.index}>
                            <span>#{chunk.index + 1}</span>
                            <S7MarkdownRenderer>{chunk.text}</S7MarkdownRenderer>
                          </article>
                        ))}
                      </div>
                      {previewQuery.data.truncated ? (
                        <p className="kb2-table-muted">
                          仅展示前 {previewQuery.data.chunks.length} 个分块。
                        </p>
                      ) : null}
                    </>
                  ) : (
                    <ProductEmpty
                      title="没有可预览内容"
                      description="返回上一步检查名称和原始文本。"
                    />
                  )}
                </section>
              ) : (
                <div className="kb2-note">
                  此处展示真实输入摘要；提交后由服务端 Job 返回处理状态和 Data 结果。
                </div>
              )}
            </div>
          ) : null}

          {step === 3 ? (
            <div className="kb2-import-result">
              {!jobId ? (
                <>
                  <ProductEmpty
                    title="准备提交导入"
                    description="提交后以服务端返回的 Job ID、状态和进度为准。"
                    action={
                      <ProductButton
                        tone="primary"
                        busy={busy}
                        disabled={kind === 'retraining'}
                        onClick={() => void submit()}
                      >
                        确认导入
                      </ProductButton>
                    }
                  />
                  <ProductError error={submitError} />
                </>
              ) : (
                <JobResultView
                  job={jobQuery.data}
                  loading={jobQuery.isLoading}
                  error={jobQuery.error}
                />
              )}
            </div>
          ) : null}

          <footer className="kb2-import-footer">
            <ProductButton
              disabled={step === 0 || Boolean(jobId)}
              onClick={() => setStep((value) => value - 1)}
            >
              上一步
            </ProductButton>
            {step < 3 ? (
              <ProductButton
                tone="primary"
                disabled={(step === 1 && !uploadsReady) || (step === 2 && !previewReady)}
                onClick={() => setStep((value) => value + 1)}
              >
                下一步
                <ChevronRightIcon boxSize={3.5} />
              </ProductButton>
            ) : jobId ? (
              <ProductButton tone="primary" onClick={props.onExit}>
                返回 Collection
              </ProductButton>
            ) : null}
          </footer>
        </main>
      </div>
    </ProductPage>
  );
}

function CatalogSelector(props: {
  items: CatalogItem[];
  selected: string[];
  onSelect: (ids: string[]) => void;
  onEnterDirectory: (id: string) => void;
}) {
  return (
    <div className="kb2-catalog-list">
      {props.items.length === 0 ? (
        <div className="kb2-center-state">尚未读取目录</div>
      ) : (
        props.items.map((item) => (
          <div className="kb2-catalog-row" key={`${item.type}-${item.id}`}>
            {item.type === 'directory' ? (
              <>
                <ProductTypeIcon kind="folder" />
                <span>{item.name}</span>
                <ProductButton size="sm" onClick={() => props.onEnterDirectory(item.id)}>
                  进入目录
                </ProductButton>
              </>
            ) : (
              <>
                <input
                  type="checkbox"
                  checked={props.selected.includes(item.id)}
                  onChange={(event) =>
                    props.onSelect(
                      event.target.checked
                        ? [...new Set([...props.selected, item.id])]
                        : props.selected.filter((id) => id !== item.id),
                    )
                  }
                  aria-label={`选择 ${item.name}`}
                />
                <span>{item.name}</span>
                <small>文件</small>
              </>
            )}
          </div>
        ))
      )}
    </div>
  );
}

function JobResultView(props: { job?: Job; loading: boolean; error: unknown }) {
  if (props.error) return <ProductError error={props.error} />;
  if (props.loading || !props.job) {
    return <div className="kb2-center-state">正在读取服务端任务状态…</div>;
  }
  const partial = Boolean(props.job.result?.partial);
  return (
    <div className="kb2-job-result">
      <div className="kb2-job-result__head">
        <StatusTag
          value={jobStatusLabel(props.job.status)}
          tone={
            ['succeeded', 'completed'].includes(props.job.status)
              ? 'success'
              : ['failed', 'dead_letter'].includes(props.job.status)
                ? 'danger'
                : partial
                  ? 'warning'
                  : 'info'
          }
          dot
        />
        <span>{props.job.progress.percent}%</span>
      </div>
      <h3>{jobStageLabel(props.job.progress.stage || props.job.kind)}</h3>
      <div className="kb2-progress-track">
        <span style={{ width: `${Math.max(0, Math.min(100, props.job.progress.percent))}%` }} />
      </div>
      <div className="kb2-info-group">
        <InfoRow label="任务 ID" value={props.job.jobId} />
        <InfoRow label="状态" value={jobStatusLabel(props.job.status)} />
        <InfoRow
          label="进度"
          value={`${props.job.progress.completed}/${props.job.progress.total}`}
        />
        {props.job.result?.sourceCount !== undefined ? (
          <InfoRow label="Sources" value={String(props.job.result.sourceCount)} />
        ) : null}
      </div>
      {props.job.error ? (
        <div className="kb2-error-panel" role="alert">
          <WarningIcon boxSize={4} />
          <div>
            <strong>{props.job.error.code ?? '导入失败'}</strong>
            <span>请根据任务 ID 查看服务端错误详情。</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function InfoRow(props: { label: string; value: string }) {
  return (
    <div className="kb2-info-line">
      <span>{props.label}</span>
      <strong title={props.value}>{props.value}</strong>
    </div>
  );
}

function normalizeImportKind(value?: string): ImportKind {
  if (value === 'fileLink' || value === 'url') return 'url';
  if (value === 'fileCustom' || value === 'text') return 'text';
  if (value === 'apiDataset' || value === 'api_library') return 'api';
  if (value === 'imageDataset' || value === 'image') return 'image';
  if (value === 'reTraining' || value === 'retraining') return 'retraining';
  if (
    value === 'template' ||
    value === 'backup' ||
    value === 'feishu' ||
    value === 'yuque' ||
    value === 'dingtalk'
  ) {
    return value;
  }
  return 'local';
}

function isConnectorKind(value: ImportKind): value is 'feishu' | 'yuque' | 'dingtalk' {
  return value === 'feishu' || value === 'yuque' || value === 'dingtalk';
}

function customApiConfig(baseUrl: string) {
  return {
    provider: 'custom_api',
    baseUrl,
    catalogPath: '/v1/file/list',
    detailPath: '/v1/file/detail',
    contentPath: '/v1/file/content',
    previewPath: '/v1/file/read',
    pageMode: 'cursor',
  };
}

function customApiCredentials(authorization: string) {
  return {
    provider: 'custom_api',
    authMode: authorization ? 'bearer' : 'none',
    ...(authorization ? { authorization } : {}),
  };
}

function jobStatusLabel(status: string) {
  const labels: Record<string, string> = {
    queued: '等待处理',
    running: '处理中',
    paused: '已暂停',
    retry_wait: '等待重试',
    succeeded: '已完成',
    failed: '失败',
    dead_letter: '重试耗尽',
    cancelled: '已取消',
  };
  return labels[status] ?? status;
}

function jobStageLabel(stage: string) {
  const labels: Record<string, string> = {
    queued: '等待处理',
    parse: '内容解析',
    parsing: '内容解析',
    segment: '数据分块',
    qa: '问答生成',
    ocr: '图片识别',
    caption: '图片描述',
    embed: '向量化',
    index: '建立索引',
    fulltext: '全文索引',
    rebuild: '重建索引',
    sync: '同步数据',
  };
  return labels[stage] ?? stage;
}

function previewSummary(input: {
  kind: ImportKind;
  uploaded: ImportedUpload[];
  textName: string;
  textBody: string;
  url: string;
  apiSelected: string[];
  connectorSelected: string[];
  collectionId?: string;
}) {
  if (input.kind === 'local' || input.kind === 'image') {
    return {
      title: `${input.uploaded.length} 个文件准备导入`,
      description: '上传进度来自真实上传事件。',
      rows: input.uploaded.map((file) => ({ label: file.name, value: `${file.progress}%` })),
    };
  }
  if (input.kind === 'text') {
    return {
      title: input.textName || '自定义文本',
      description: `${input.textBody.length} 个字符`,
      rows: [{ label: '内容长度', value: `${input.textBody.length} 字符` }],
    };
  }
  if (input.kind === 'url') {
    return {
      title: '网页导入',
      description: input.url,
      rows: [{ label: 'URL', value: input.url }],
    };
  }
  if (input.kind === 'api') {
    return {
      title: `${input.apiSelected.length} 个 API 文件`,
      description: '文件 ID 来自真实 API 目录。',
      rows: input.apiSelected.map((id) => ({ label: '文件 ID', value: id })),
    };
  }
  if (isConnectorKind(input.kind)) {
    return {
      title: `${input.connectorSelected.length} 个外部文档`,
      description: '外部 ID 来自真实连接器目录。',
      rows: input.connectorSelected.map((id) => ({ label: '外部 ID', value: id })),
    };
  }
  if (input.kind === 'retraining') {
    return {
      title: '重训练',
      description: input.collectionId ?? '',
      rows: [{ label: 'Source ID', value: input.collectionId ?? '未提供' }],
    };
  }
  return {
    title: input.kind === 'backup' ? '备份文件' : '模板文件',
    description: input.uploaded[0]?.name ?? '',
    rows: [{ label: '文件', value: input.uploaded[0]?.name ?? '未选择' }],
  };
}
