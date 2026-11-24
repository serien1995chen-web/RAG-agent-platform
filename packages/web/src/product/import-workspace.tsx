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
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
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
  previewImportBackup,
  previewImportFile,
  previewImportTemplate,
  previewImportText,
  productApi,
  productErrorView,
  type ImportUrlPreview,
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
} from './ui';
import type { CatalogItem, Directory, Job, ProviderCatalogItem } from './types';
import { knowledgeMultipartUpload, type KnowledgeFileUploadState } from '../client/file-upload';

// This product form mirrors the shared S5ParseSettingsPanel contract while preserving
// the product workspace layout and its three-viewport import flow.

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

type UrlEntryPhase = 'waiting' | 'previewing' | 'ready' | 'creating' | 'finished' | 'error';

interface UrlEntry {
  id: string;
  idempotencyKey: string;
  url: string;
  phase: UrlEntryPhase;
  preview?: ImportUrlPreview;
  previewSignature?: string;
  jobId?: string;
  error?: unknown;
}

function urlLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function createUrlEntry(url: string): UrlEntry {
  return {
    id: globalThis.crypto.randomUUID(),
    idempotencyKey: globalThis.crypto.randomUUID(),
    url,
    phase: 'waiting',
  };
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
const DIRECT_SELECTION_KINDS: ImportKind[] = ['local', 'text', 'url'];

export function ImportWorkspace(props: {
  spaceId: string;
  datasetName: string;
  initialDirectoryId?: string;
  initialSource?: string;
  collectionId?: string;
  initialJobId?: string;
  existingExternalIds?: string[];
  onExit: () => void;
  onImported: () => void;
  onJobStarted?: (jobId: string) => void;
}) {
  const queryClient = useQueryClient();
  const initialKind = normalizeImportKind(props.initialSource);
  const [kind, setKind] = useState<ImportKind>(initialKind);
  const [step, setStep] = useState(props.initialJobId ? 3 : initialKind === 'retraining' ? 1 : 0);
  const [directoryId, setDirectoryId] = useState(props.initialDirectoryId ?? '');
  const [parseProvider, setParseProvider] = useState('liteparse');
  const [customPdfParse, setCustomPdfParse] = useState(true);
  const [credentialProfileId, setCredentialProfileId] = useState('');
  const [fallbackProvider, setFallbackProvider] = useState<'liteparse' | 'none'>('liteparse');
  const [imageHandling, setImageHandling] = useState<'upload_to_storage' | 'keep_url' | 'drop'>(
    'upload_to_storage',
  );
  const [parseTimeoutMs, setParseTimeoutMs] = useState('120000');
  const [textinParseMode, setTextinParseMode] = useState<'auto' | 'scan'>('auto');
  const [textinRemoveWatermark, setTextinRemoveWatermark] = useState(true);
  const [doc2xPollIntervalMs, setDoc2xPollIntervalMs] = useState('5000');
  const [trainingType, setTrainingType] = useState<'chunk' | 'qa' | 'imageParse'>(
    initialKind === 'image' ? 'imageParse' : 'chunk',
  );
  const [chunkSettingMode, setChunkSettingMode] = useState<'auto' | 'custom'>('auto');
  const [chunkTriggerType, setChunkTriggerType] = useState<'minSize' | 'forceChunk' | 'maxSize'>(
    'minSize',
  );
  const [chunkTriggerMinSize, setChunkTriggerMinSize] = useState('1000');
  const [chunkSize, setChunkSize] = useState('1000');
  const [chunkSplitMode, setChunkSplitMode] = useState<'paragraph' | 'size' | 'char'>('paragraph');
  const [paragraphChunkAIMode, setParagraphChunkAIMode] = useState<'auto' | 'force' | 'forbid'>(
    'forbid',
  );
  const [paragraphChunkDeep, setParagraphChunkDeep] = useState('5');
  const [paragraphChunkMinSize, setParagraphChunkMinSize] = useState('100');
  const [chunkSplitter, setChunkSplitter] = useState('');
  const [overlap, setOverlap] = useState('100');
  const [indexSize, setIndexSize] = useState('512');
  const [autoIndexes, setAutoIndexes] = useState(false);
  const [imageIndex, setImageIndex] = useState(false);
  const [indexPrefixTitle, setIndexPrefixTitle] = useState(false);
  const [qaPrompt, setQaPrompt] = useState('');
  const [uploaded, setUploaded] = useState<ImportedUpload[]>([]);
  const [uploading, setUploading] = useState(false);
  const uploadControllers = useRef(new Map<string, AbortController>());
  const uploadFilesByRow = useRef(new Map<string, File>());
  const [textName, setTextName] = useState('');
  const [textBody, setTextBody] = useState('');
  const [urlText, setUrlText] = useState('');
  const [urlEntries, setUrlEntries] = useState<UrlEntry[]>([]);
  const [selector, setSelector] = useState('body');
  const [dryRun, setDryRun] = useState(false);
  const [conflictStrategy, setConflictStrategy] = useState<'fail' | 'skip' | 'overwrite'>('fail');
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [apiAuthorization, setApiAuthorization] = useState('');
  const [apiCatalog, setApiCatalog] = useState<CatalogItem[]>([]);
  const [apiSelected, setApiSelected] = useState<string[]>([]);
  const [apiPath, setApiPath] = useState<Array<{ id: string; name: string }>>([]);
  const [connectorItems, setConnectorItems] = useState<CatalogItem[]>([]);
  const [connectorSelected, setConnectorSelected] = useState<string[]>([]);
  const [connectorPath, setConnectorPath] = useState<Array<{ id: string; name: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [jobId, setJobId] = useState(props.initialJobId ?? '');
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [localPreviewUploadId, setLocalPreviewUploadId] = useState<string | null>(null);
  const [showLegacyProcessingSettings] = useState(false);
  const textNameRef = useRef<HTMLInputElement>(null);
  const textBodyRef = useRef<HTMLTextAreaElement>(null);
  const urlTextRef = useRef<HTMLTextAreaElement>(null);
  const localPreviewScrollRef = useRef<HTMLDivElement>(null);

  const directoriesQuery = useQuery<Directory[]>({
    queryKey: ['kb-product', 'import-directories', props.spaceId],
    queryFn: () => productApi.listDirectories(props.spaceId),
  });
  const modelsQuery = useQuery({
    queryKey: ['kb-product', 'models'],
    queryFn: () => productApi.listModels(),
  });
  const bindingsQuery = useQuery({
    queryKey: ['kb-product', 'model-bindings', props.spaceId],
    queryFn: () => productApi.getModelBindings(props.spaceId),
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
      autoIndexes,
      imageIndex,
      indexPrefixTitle,
      ...(chunkSettingMode === 'custom'
        ? {
            chunkTriggerType,
            chunkTriggerMinSize: Number(chunkTriggerMinSize) || 1,
            chunkSize: Number(chunkSize) || 1000,
            overlap: Number(overlap) || 0,
            indexSize: Number(indexSize) || 1000,
          }
        : {}),
      ...(chunkSplitMode === 'paragraph' && trainingType === 'chunk'
        ? {
            paragraphChunkAIMode,
            paragraphChunkDeep: Number(paragraphChunkDeep) || 5,
            paragraphChunkMinSize: Number(paragraphChunkMinSize) || 100,
          }
        : {}),
      ...(chunkSplitMode === 'char' && chunkSplitter.trim()
        ? { chunkSplitter: chunkSplitter.trim() }
        : {}),
      ...(trainingType === 'qa' && qaPrompt.trim() ? { qaPrompt: qaPrompt.trim() } : {}),
    }),
    [
      chunkSettingMode,
      chunkSize,
      chunkSplitMode,
      chunkSplitter,
      chunkTriggerMinSize,
      chunkTriggerType,
      indexSize,
      overlap,
      paragraphChunkAIMode,
      paragraphChunkDeep,
      paragraphChunkMinSize,
      qaPrompt,
      autoIndexes,
      imageIndex,
      indexPrefixTitle,
      trainingType,
    ],
  );
  const indexCapabilities = useMemo(() => {
    const models = modelsQuery.data ?? [];
    const hasAutoIndexModel = models.some((model) => model.authorized && model.type === 'llm');
    const hasVlmModel = models.some((model) => model.authorized && model.type === 'vlm');
    const hasImageEmbeddingModel = models.some(
      (model) =>
        model.authorized &&
        model.type === 'embedding' &&
        (model.capabilities.includes('vision') || model.capabilities.includes('caption-embedding')),
    );
    return {
      autoIndexes: trainingType === 'chunk' && hasAutoIndexModel,
      indexPrefixTitle: trainingType === 'chunk' && hasAutoIndexModel && autoIndexes,
      imageIndex: trainingType === 'chunk' && hasVlmModel && hasImageEmbeddingModel,
    };
  }, [autoIndexes, modelsQuery.data, trainingType]);

  const boundModel = useMemo(
    () => (type: 'llm' | 'embedding') => {
      const modelId =
        bindingsQuery.data?.items.find(
          (binding) => binding.modelType === type && binding.status === 'active',
        )?.modelId ?? '';
      const models = modelsQuery.data ?? [];
      return (
        models.find((model) => model.modelId === modelId && model.authorized) ??
        models.find((model) => model.type === type && model.authorized)
      );
    },
    [bindingsQuery.data, modelsQuery.data],
  );
  const modelLimits = useMemo(() => {
    const llm = boundModel('llm');
    const embedding = boundModel('embedding');
    const maxContext = llm?.limits?.maxContext ?? 8_000;
    const maxResponse = llm?.limits?.maxResponse ?? 0;
    return {
      maxChunkSize: Math.min(Math.max(maxContext - maxResponse, 2_000), 100_000),
      maxIndexSize: embedding?.limits?.maxToken ?? 512,
      defaultIndexSize: embedding?.limits?.defaultToken ?? 512,
    };
  }, [boundModel]);
  const indexSizeOptions = useMemo(
    () =>
      [64, 128, 256, 512, 768, 1024, 1536, 2048, 3072, 4096, 5120, 6144, 7168, 8192].filter(
        (value) => value <= modelLimits.maxIndexSize,
      ),
    [modelLimits.maxIndexSize],
  );
  useEffect(() => {
    if (modelsQuery.isLoading || bindingsQuery.isLoading) return;
    setIndexSize((current) => {
      const parsed = Number(current);
      if (indexSizeOptions.includes(parsed)) return current;
      return String(modelLimits.defaultIndexSize);
    });
    setChunkSize((current) => {
      const parsed = Number(current);
      if (!Number.isFinite(parsed)) return '1000';
      return String(Math.min(Math.max(parsed, 64), modelLimits.maxChunkSize));
    });
  }, [
    bindingsQuery.isLoading,
    indexSizeOptions,
    modelLimits.defaultIndexSize,
    modelLimits.maxChunkSize,
    modelsQuery.isLoading,
  ]);

  useEffect(() => {
    if (modelsQuery.isLoading) return;
    if (!indexCapabilities.autoIndexes) setAutoIndexes(false);
    if (!indexCapabilities.indexPrefixTitle) setIndexPrefixTitle(false);
    if (!indexCapabilities.imageIndex) setImageIndex(false);
  }, [
    indexCapabilities.autoIndexes,
    indexCapabilities.imageIndex,
    indexCapabilities.indexPrefixTitle,
    modelsQuery.isLoading,
  ]);
  const parseConfig = useMemo<Record<string, unknown>>(() => {
    if (parseProvider === 'liteparse') return { customPdfParse };
    const common = {
      provider: parseProvider,
      credentialProfileId: credentialProfileId.trim(),
      fallbackProvider,
      imageHandling,
      timeoutMs: Number(parseTimeoutMs) || 120_000,
    };
    if (parseProvider === 'textin') {
      return {
        ...common,
        parseMode: textinParseMode,
        removeWatermark: textinRemoveWatermark,
      };
    }
    if (parseProvider === 'doc2x') {
      return {
        ...common,
        pollIntervalMs: Number(doc2xPollIntervalMs) || 5_000,
      };
    }
    if (parseProvider === 'sangfor') {
      return {
        ...common,
        keepHeaderFooter: false,
        keepAppendix: true,
        imageAnalysis: false,
        chartAnalysis: false,
      };
    }
    return common;
  }, [
    credentialProfileId,
    doc2xPollIntervalMs,
    fallbackProvider,
    imageHandling,
    parseProvider,
    customPdfParse,
    parseTimeoutMs,
    textinParseMode,
    textinRemoveWatermark,
  ]);
  const normalizedSelector = selector.trim() || 'body';
  const urlPreviewSignature = JSON.stringify({ selector: normalizedSelector, chunking });
  const invalidateUrlPreviews = () => {
    setUrlEntries((current) =>
      current.map((entry) => ({
        ...entry,
        phase: entry.phase === 'finished' ? entry.phase : 'waiting',
        preview: entry.phase === 'finished' ? entry.preview : undefined,
        previewSignature: entry.phase === 'finished' ? entry.previewSignature : undefined,
      })),
    );
  };
  const updateUrlText = (nextText: string) => {
    setUrlText(nextText);
    const lines = urlLines(nextText);
    setUrlEntries((current) => {
      const used = new Set<number>();
      return lines.map((line) => {
        const matched = current.findIndex((entry, index) => !used.has(index) && entry.url === line);
        if (matched >= 0) {
          used.add(matched);
          return current[matched]!;
        }
        return createUrlEntry(line);
      });
    });
  };
  const removeUrlEntry = (target: UrlEntry) => {
    const remaining = urlEntries.filter((entry) => entry.id !== target.id);
    setUrlEntries(remaining);
    setUrlText(remaining.map((entry) => entry.url).join('\n'));
  };
  const previewUrl = async (target: UrlEntry) => {
    setUrlEntries((current) =>
      current.map((entry) =>
        entry.id === target.id
          ? { ...entry, phase: 'previewing', preview: undefined, error: undefined }
          : entry,
      ),
    );
    try {
      const preview = await importUrl(props.spaceId, {
        url: target.url,
        selector: normalizedSelector,
        directoryId: directoryId || null,
        chunking,
        idempotencyKey: target.idempotencyKey,
        dryRun: true,
      });
      setUrlEntries((current) =>
        current.map((entry) =>
          entry.id === target.id
            ? {
                ...entry,
                phase: 'ready',
                preview,
                previewSignature: urlPreviewSignature,
                error: undefined,
              }
            : entry,
        ),
      );
    } catch (caught) {
      setUrlEntries((current) =>
        current.map((entry) =>
          entry.id === target.id ? { ...entry, phase: 'error', error: caught } : entry,
        ),
      );
    }
  };
  const completedUploads = uploaded.filter(
    (item) => item.phase === 'completed' && Boolean(item.id),
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
  const localPreviewUpload = completedUploads.find((item) => item.id === localPreviewUploadId);
  const localFilePreviewQuery = useQuery({
    queryKey: [
      'kb-product',
      'local-file-preview',
      props.spaceId,
      localPreviewUploadId,
      parseConfig,
      chunking,
    ],
    queryFn: () =>
      previewImportFile(props.spaceId, {
        uploadId: localPreviewUploadId!,
        directoryId: directoryId || null,
        parseProvider,
        parseConfig,
        chunking,
      }),
    enabled: step === 2 && (kind === 'local' || kind === 'image') && Boolean(localPreviewUploadId),
  });
  useEffect(() => {
    localPreviewScrollRef.current?.scrollTo({ top: 0, left: 0 });
  }, [localPreviewUploadId]);
  const activeOption = IMPORT_OPTIONS.find((option) => option.kind === kind)!;
  const directSelection = DIRECT_SELECTION_KINDS.includes(kind);
  const showFormStep = directSelection ? step <= 1 : step === 1;
  const stepLabels =
    kind === 'url'
      ? (['输入链接', '参数设置', '数据预览', '确认导入'] as const)
      : directSelection
        ? (['选择文件', '参数设置', '数据预览', '确认导入'] as const)
        : STEP_LABELS;
  const structuredPreviewQuery = useQuery({
    queryKey: [
      'kb-product',
      'structured-import-preview',
      props.spaceId,
      kind,
      completedUploads[0]?.id,
      conflictStrategy,
    ],
    queryFn: () => {
      const uploadId = completedUploads[0]!.id;
      return kind === 'backup'
        ? previewImportBackup(props.spaceId, {
            uploadId,
            directoryId: directoryId || null,
            conflictStrategy,
          })
        : previewImportTemplate(props.spaceId, {
            uploadId,
            directoryId: directoryId || null,
          });
    },
    enabled:
      step === 2 && (kind === 'template' || kind === 'backup') && completedUploads.length === 1,
  });
  const uploadsReady =
    (['local', 'image'].includes(kind) && completedUploads.length > 0) ||
    (['template', 'backup'].includes(kind) && completedUploads.length === 1) ||
    (kind === 'text' && Boolean(textName.trim()) && Boolean(textBody.trim())) ||
    (kind === 'url' && urlEntries.length > 0) ||
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
    setApiPath([]);
    setConnectorItems([]);
    setConnectorSelected([]);
    setConnectorPath([]);
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

  const browseApi = async (
    parentId = apiPath.at(-1)?.id ?? '',
    nextPath: Array<{ id: string; name: string }> = apiPath,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const items: CatalogItem[] = [];
      let cursor: string | undefined;
      do {
        const result = await apiLibraryCatalog(props.spaceId, {
          config: customApiConfig(apiBaseUrl),
          credentials: customApiCredentials(apiAuthorization),
          parentId,
          ...(cursor ? { cursor } : {}),
        });
        items.push(...result.items);
        cursor = result.nextCursor ?? undefined;
      } while (cursor);
      setApiCatalog(items);
      setApiPath(nextPath);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const browseConnector = async (
    parentId = connectorPath.at(-1)?.id ?? '',
    nextPath: Array<{ id: string; name: string }> = connectorPath,
  ) => {
    if (!isConnectorKind(kind)) return;
    setBusy(true);
    setError(null);
    try {
      const items: CatalogItem[] = [];
      let cursor: string | undefined;
      do {
        const result = await connectorCatalog(props.spaceId, kind, {
          rootId: parentId,
          ...(cursor ? { cursor } : {}),
        });
        items.push(
          ...result.items.map((item: ProviderCatalogItem) => ({
            id: String(item.id ?? item.externalId ?? ''),
            name: String(item.name ?? item.title ?? '未命名项目'),
            type: item.type,
          })),
        );
        cursor = result.nextCursor ?? undefined;
      } while (cursor);
      setConnectorItems(items.filter((item) => Boolean(item.id)));
      setConnectorPath(nextPath);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const submitUrls = async () => {
    const alreadyFinished = urlEntries.filter((entry) => entry.phase === 'finished').length;
    const pending = urlEntries.filter(
      (entry) => entry.phase !== 'finished' && entry.phase !== 'creating',
    );
    let newlyFinished = 0;
    for (const initial of pending) {
      setUrlEntries((current) =>
        current.map((entry) =>
          entry.id === initial.id ? { ...entry, phase: 'creating', error: undefined } : entry,
        ),
      );
      try {
        const job = await importUrl(props.spaceId, {
          url: initial.url,
          selector: normalizedSelector,
          directoryId: directoryId || null,
          chunking,
          idempotencyKey: initial.idempotencyKey,
          dryRun: false,
        });
        setUrlEntries((current) =>
          current.map((entry) =>
            entry.id === initial.id
              ? { ...entry, phase: 'finished', jobId: job.jobId, error: undefined }
              : entry,
          ),
        );
        newlyFinished += 1;
        props.onJobStarted?.(job.jobId);
      } catch (caught) {
        setUrlEntries((current) =>
          current.map((entry) =>
            entry.id === initial.id ? { ...entry, phase: 'error', error: caught } : entry,
          ),
        );
      }
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['kb-product', 'sources', props.spaceId] }),
      queryClient.invalidateQueries({ queryKey: ['kb-product', 'jobs', props.spaceId] }),
    ]);
    if (alreadyFinished + newlyFinished === urlEntries.length && urlEntries.length > 0) {
      props.onImported();
    }
  };

  const submit = async () => {
    setBusy(true);
    setSubmitError(null);
    try {
      if (kind === 'url') {
        await submitUrls();
        return;
      }
      let job: Job;
      if (kind === 'local' || kind === 'image') {
        job = await importFiles(props.spaceId, {
          uploadIds: completedUploads.map((item) => item.id),
          directoryId: directoryId || null,
          parseProvider,
          parseConfig: parseConfig,
          chunking,
        });
      } else if (kind === 'text') {
        job = await importText(props.spaceId, {
          name: textName.trim(),
          text: textBody,
          directoryId: directoryId || null,
          chunking,
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
    } catch (caught) {
      setSubmitError(caught);
    } finally {
      setBusy(false);
    }
  };

  const downloadTemplate = () => {
    const csv = [
      'q,a,index,index,metadata',
      '"Who are you?","I am an AI assistant.","identity","assistant","{""source"":""template""}"',
      '"What can you do?","I can answer questions from the imported knowledge.","help","faq","{""source"":""template""}"',
    ].join('\r\n');
    const url = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'template.csv';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const downloadBackup = async () => {
    setBusy(true);
    setError(null);
    try {
      let job = await productApi.exportSpace(props.spaceId, 'csv');
      const deadline = Date.now() + 120_000;
      while (!['succeeded', 'failed', 'dead_letter', 'cancelled'].includes(job.status)) {
        if (Date.now() >= deadline) throw new Error('备份导出超时，请重试。');
        await new Promise((resolveWait) => window.setTimeout(resolveWait, 1_000));
        job = await productApi.getJob(job.jobId);
      }
      if (job.status !== 'succeeded') throw new Error(`备份导出失败：${job.status}`);
      const blobId = job.result?.objectBlobRefId;
      if (typeof blobId !== 'string') throw new Error('备份导出缺少文件结果。');
      const ticket = await productApi.downloadFile(blobId);
      const anchor = document.createElement('a');
      anchor.href = ticket.url;
      anchor.download = `knowledge-backup-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const confirmDryRunRestore = async () => {
    setBusy(true);
    setSubmitError(null);
    try {
      const job = await importBackup(props.spaceId, {
        uploadId: completedUploads[0]!.id,
        directoryId: directoryId || null,
        dryRun: false,
        conflictStrategy,
      });
      setJobId(job.jobId);
      props.onJobStarted?.(job.jobId);
      await queryClient.invalidateQueries({
        queryKey: ['kb-product', 'jobs', props.spaceId],
      });
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
    urlCount: urlEntries.length,
    apiSelected,
    connectorSelected,
    collectionId: props.collectionId,
  });
  const previewReady =
    step !== 2 ||
    (kind === 'text'
      ? !previewQuery.isLoading &&
        !previewQuery.error &&
        Boolean(previewQuery.data && previewQuery.data.totalChunks > 0)
      : kind === 'template' || kind === 'backup'
        ? !structuredPreviewQuery.isLoading &&
          !structuredPreviewQuery.error &&
          Boolean(structuredPreviewQuery.data)
        : kind === 'url'
          ? urlEntries.length > 0 &&
            urlEntries.every(
              (entry) =>
                entry.phase === 'ready' &&
                Boolean(entry.preview) &&
                entry.previewSignature === urlPreviewSignature,
            )
          : true);

  const advanceStep = () => {
    if (step === 0 && kind === 'text') {
      if (!textName.trim()) {
        textNameRef.current?.focus();
        return;
      }
      if (!textBody.trim()) {
        textBodyRef.current?.focus();
        return;
      }
    }
    if (step === 0 && kind === 'url' && urlEntries.length === 0) {
      urlTextRef.current?.focus();
      return;
    }
    setStep((value) => Math.min(3, value + 1));
  };

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
        {stepLabels.map((label, index) => (
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

      <div className={`kb2-import-body${step > 0 ? ' is-centered' : ''}`}>
        {step === 0 ? (
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
        ) : null}

        <main className="kb2-import-main">
          {step === 0 && !directSelection ? (
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

          {showFormStep ? (
            <div className="kb2-import-form">
              {(step === 0 && kind === 'local') ||
              (step === 1 && ['image', 'template', 'backup'].includes(kind)) ? (
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

              {kind === 'template' ? (
                <div className="kb2-inline-actions">
                  <ProductButton onClick={downloadTemplate}>下载 CSV 模板</ProductButton>
                  <span>字段：q、a、index（可多列）、metadata（JSON）</span>
                </div>
              ) : null}

              {kind === 'backup' ? (
                <div className="kb2-inline-actions">
                  <ProductButton busy={busy} onClick={() => void downloadBackup()}>
                    下载空间 CSV 备份
                  </ProductButton>
                  <span>备份包含 q、a、index、metadata 和 schemaVersion。</span>
                </div>
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

              {step === 0 && kind === 'text' ? (
                <div className="kb2-form-grid">
                  <ProductField label="名称">
                    <ProductInput
                      ref={textNameRef}
                      value={textName}
                      onChange={(event) => setTextName(event.target.value)}
                    />
                  </ProductField>
                  <div className="kb2-form-grid__full">
                    <ProductField label="文本内容">
                      <ProductTextarea
                        ref={textBodyRef}
                        value={textBody}
                        onChange={(event) => setTextBody(event.target.value)}
                        rows={10}
                      />
                    </ProductField>
                  </div>
                </div>
              ) : null}

              {step === 0 && kind === 'url' ? (
                <div className="kb2-form-grid">
                  <ProductField
                    label="网页地址"
                    hint="每行一个 URL；空白行会忽略，每个条目只抓取当前页面"
                  >
                    <ProductTextarea
                      ref={urlTextRef}
                      value={urlText}
                      onChange={(event) => updateUrlText(event.target.value)}
                      rows={7}
                      placeholder={'https://example.com/page\nhttps://example.com/another-page'}
                    />
                  </ProductField>
                  <ProductField label="内容选择器" hint="默认抓取 body">
                    <ProductInput
                      value={selector}
                      onChange={(event) => {
                        setSelector(event.target.value);
                        invalidateUrlPreviews();
                      }}
                    />
                  </ProductField>
                  <div className="kb2-url-tags" role="group" aria-label="待导入网页">
                    {urlEntries.map((entry) => (
                      <span className="kb2-url-tag" data-testid="b10-url-tag" key={entry.id}>
                        <span>{entry.url}</span>
                        <button
                          type="button"
                          aria-label={`删除 ${entry.url}`}
                          onClick={() => removeUrlEntry(entry)}
                        >
                          <CloseIcon boxSize={3} />
                        </button>
                      </span>
                    ))}
                  </div>
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
                  </div>
                  <ProductButton busy={busy} onClick={() => void browseApi()}>
                    读取 API 目录
                  </ProductButton>
                  <CatalogSelector
                    items={apiCatalog}
                    selected={apiSelected}
                    onSelect={setApiSelected}
                    path={apiPath}
                    existingIds={props.existingExternalIds ?? []}
                    onNavigate={(nextPath) => void browseApi(nextPath.at(-1)?.id ?? '', nextPath)}
                  />
                </div>
              ) : null}

              {isConnectorKind(kind) ? (
                <div className="kb2-import-connect">
                  <ProductButton busy={busy} onClick={() => void browseConnector()}>
                    读取连接器目录
                  </ProductButton>
                  <CatalogSelector
                    items={connectorItems}
                    selected={connectorSelected}
                    onSelect={setConnectorSelected}
                    path={connectorPath}
                    existingIds={props.existingExternalIds ?? []}
                    onNavigate={(nextPath) =>
                      void browseConnector(nextPath.at(-1)?.id ?? '', nextPath)
                    }
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

              {step === 1 &&
              (kind === 'local' || kind === 'image' || kind === 'text' || kind === 'url') ? (
                <ProcessingSettings
                  kind={kind}
                  customPdfParse={customPdfParse}
                  setCustomPdfParse={setCustomPdfParse}
                  trainingType={trainingType}
                  setTrainingType={setTrainingType}
                  chunkSettingMode={chunkSettingMode}
                  setChunkSettingMode={setChunkSettingMode}
                  chunkTriggerType={chunkTriggerType}
                  setChunkTriggerType={setChunkTriggerType}
                  chunkTriggerMinSize={chunkTriggerMinSize}
                  setChunkTriggerMinSize={setChunkTriggerMinSize}
                  chunkSplitMode={chunkSplitMode}
                  setChunkSplitMode={setChunkSplitMode}
                  chunkSize={chunkSize}
                  setChunkSize={setChunkSize}
                  chunkSplitter={chunkSplitter}
                  setChunkSplitter={setChunkSplitter}
                  paragraphChunkAIMode={paragraphChunkAIMode}
                  setParagraphChunkAIMode={setParagraphChunkAIMode}
                  paragraphChunkDeep={paragraphChunkDeep}
                  setParagraphChunkDeep={setParagraphChunkDeep}
                  indexSize={indexSize}
                  setIndexSize={setIndexSize}
                  indexSizeOptions={indexSizeOptions}
                  maxChunkSize={modelLimits.maxChunkSize}
                  autoIndexes={autoIndexes}
                  setAutoIndexes={setAutoIndexes}
                  imageIndex={imageIndex}
                  setImageIndex={setImageIndex}
                  indexPrefixTitle={indexPrefixTitle}
                  setIndexPrefixTitle={setIndexPrefixTitle}
                  indexCapabilities={indexCapabilities}
                  modelsLoading={modelsQuery.isLoading}
                  qaPrompt={qaPrompt}
                  setQaPrompt={setQaPrompt}
                  onInvalidate={invalidateUrlPreviews}
                />
              ) : null}

              {showLegacyProcessingSettings &&
              step === 1 &&
              (kind === 'local' || kind === 'image' || kind === 'text' || kind === 'url') ? (
                <div className="kb2-import-settings">
                  <h3>训练参数</h3>
                  <div className="kb2-form-grid">
                    {kind === 'local' || kind === 'image' ? (
                      <label className="kb2-checkbox-row kb2-form-grid__full">
                        <input
                          type="checkbox"
                          checked={customPdfParse}
                          onChange={(event) => setCustomPdfParse(event.target.checked)}
                        />
                        <span>PDF增强解析</span>
                      </label>
                    ) : null}
                    {kind === 'local' || kind === 'image' ? (
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
                    ) : null}
                    {kind === 'local' || kind === 'image' ? (
                      parseProvider !== 'liteparse' ? (
                        <>
                          <ProductField label="凭据配置">
                            <ProductInput
                              value={credentialProfileId}
                              autoComplete="off"
                              placeholder="env:S11_OCR_PROFILE"
                              onChange={(event) => setCredentialProfileId(event.target.value)}
                            />
                          </ProductField>
                          <ProductField label="回退">
                            <ProductSelect
                              value={fallbackProvider}
                              onChange={(event) =>
                                setFallbackProvider(event.target.value as typeof fallbackProvider)
                              }
                            >
                              <option value="liteparse">LiteParse</option>
                              <option value="none">不回退</option>
                            </ProductSelect>
                          </ProductField>
                          <ProductField label="图片处理">
                            <ProductSelect
                              value={imageHandling}
                              onChange={(event) =>
                                setImageHandling(event.target.value as typeof imageHandling)
                              }
                            >
                              <option value="upload_to_storage">转存到对象存储</option>
                              <option value="keep_url">保留远程 URL</option>
                              <option value="drop">丢弃图片</option>
                            </ProductSelect>
                          </ProductField>
                          <ProductField label="超时">
                            <ProductInput
                              aria-label="超时"
                              type="number"
                              min={1000}
                              max={600000}
                              value={parseTimeoutMs}
                              onChange={(event) => setParseTimeoutMs(event.target.value)}
                            />
                          </ProductField>
                          {parseProvider === 'textin' ? (
                            <>
                              <ProductField label="TextIn 解析模式">
                                <ProductSelect
                                  value={textinParseMode}
                                  onChange={(event) =>
                                    setTextinParseMode(event.target.value as typeof textinParseMode)
                                  }
                                >
                                  <option value="auto">自动</option>
                                  <option value="scan">扫描</option>
                                </ProductSelect>
                              </ProductField>
                              <label className="kb2-checkbox-row">
                                <input
                                  type="checkbox"
                                  checked={textinRemoveWatermark}
                                  onChange={(event) =>
                                    setTextinRemoveWatermark(event.target.checked)
                                  }
                                />
                                <span>移除水印</span>
                              </label>
                            </>
                          ) : null}
                          {parseProvider === 'doc2x' ? (
                            <ProductField label="Doc2X 轮询间隔">
                              <ProductInput
                                type="number"
                                min={100}
                                max={60000}
                                value={doc2xPollIntervalMs}
                                onChange={(event) => setDoc2xPollIntervalMs(event.target.value)}
                              />
                            </ProductField>
                          ) : null}
                        </>
                      ) : null
                    ) : null}
                    <ProductField label="训练类型">
                      <ProductSelect
                        value={trainingType}
                        onChange={(event) => {
                          setTrainingType(event.target.value as typeof trainingType);
                          invalidateUrlPreviews();
                        }}
                      >
                        <option value="chunk">分段</option>
                        <option value="qa">问答对</option>
                        {kind === 'image' ? <option value="imageParse">图片解析</option> : null}
                      </ProductSelect>
                    </ProductField>
                    <ProductField label="切分方式">
                      <ProductSelect
                        value={chunkSettingMode}
                        onChange={(event) => {
                          setChunkSettingMode(event.target.value as typeof chunkSettingMode);
                          invalidateUrlPreviews();
                        }}
                      >
                        <option value="auto">自动</option>
                        <option value="intelligent">智能</option>
                        <option value="custom">自定义</option>
                      </ProductSelect>
                    </ProductField>
                    <ProductField label="分块条件">
                      <ProductSelect
                        value={chunkTriggerType}
                        onChange={(event) => {
                          setChunkTriggerType(event.target.value as typeof chunkTriggerType);
                          invalidateUrlPreviews();
                        }}
                      >
                        <option value="minSize">原文长度大于</option>
                        <option value="maxSize">原文长度小于</option>
                        <option value="forceChunk">强制分块</option>
                      </ProductSelect>
                    </ProductField>
                    <ProductField label="切分模式">
                      <ProductSelect
                        value={chunkSplitMode}
                        onChange={(event) => {
                          setChunkSplitMode(event.target.value as typeof chunkSplitMode);
                          invalidateUrlPreviews();
                        }}
                      >
                        <option value="paragraph">按段落</option>
                        <option value="size">按长度</option>
                        <option value="char">按字符</option>
                      </ProductSelect>
                    </ProductField>
                    <ProductField label="分块大小">
                      <ProductInput
                        type="number"
                        min={64}
                        max={8000}
                        value={chunkSize}
                        onChange={(event) => {
                          setChunkSize(event.target.value);
                          invalidateUrlPreviews();
                        }}
                      />
                    </ProductField>
                    <ProductField label="分块条件值">
                      <ProductInput
                        type="number"
                        min={1}
                        max={8000}
                        value={chunkTriggerMinSize}
                        onChange={(event) => {
                          setChunkTriggerMinSize(event.target.value);
                          invalidateUrlPreviews();
                        }}
                      />
                    </ProductField>
                    <ProductField label="段落 AI 模式">
                      <ProductSelect
                        value={paragraphChunkAIMode}
                        onChange={(event) => {
                          setParagraphChunkAIMode(
                            event.target.value as typeof paragraphChunkAIMode,
                          );
                          invalidateUrlPreviews();
                        }}
                      >
                        <option value="auto">自动</option>
                        <option value="force">强制</option>
                        <option value="forbid">禁用</option>
                      </ProductSelect>
                    </ProductField>
                    <ProductField label="最大段落深度">
                      <ProductInput
                        type="number"
                        min={1}
                        max={5}
                        value={paragraphChunkDeep}
                        onChange={(event) => {
                          setParagraphChunkDeep(event.target.value);
                          invalidateUrlPreviews();
                        }}
                      />
                    </ProductField>
                    <ProductField label="最小分块长度">
                      <ProductInput
                        type="number"
                        min={1}
                        max={8000}
                        value={paragraphChunkMinSize}
                        onChange={(event) => {
                          setParagraphChunkMinSize(event.target.value);
                          invalidateUrlPreviews();
                        }}
                      />
                    </ProductField>
                    <ProductField label="分隔符">
                      <ProductTextarea
                        value={chunkSplitter}
                        placeholder="每行一个正则分隔符"
                        maxLength={1000}
                        onChange={(event) => {
                          setChunkSplitter(event.target.value);
                          invalidateUrlPreviews();
                        }}
                      />
                    </ProductField>
                    <ProductField label="重叠长度">
                      <ProductInput
                        type="number"
                        min={0}
                        max={7999}
                        value={overlap}
                        onChange={(event) => {
                          setOverlap(event.target.value);
                          invalidateUrlPreviews();
                        }}
                      />
                    </ProductField>
                    <ProductField label="索引大小">
                      <ProductInput
                        type="number"
                        min={1}
                        max={8000}
                        value={indexSize}
                        onChange={(event) => {
                          setIndexSize(event.target.value);
                          invalidateUrlPreviews();
                        }}
                      />
                    </ProductField>
                    <div className="kb2-index-enhancements">
                      <div className="kb2-index-enhancement">
                        <label className="kb2-checkbox-row">
                          <input
                            type="checkbox"
                            aria-label="自动生成补充索引"
                            aria-describedby={
                              indexCapabilities.autoIndexes ? undefined : 'index-auto-unavailable'
                            }
                            checked={autoIndexes}
                            disabled={!indexCapabilities.autoIndexes}
                            onChange={(event) => {
                              setAutoIndexes(event.target.checked);
                              if (!event.target.checked) setIndexPrefixTitle(false);
                              invalidateUrlPreviews();
                            }}
                          />
                          <span>自动生成补充索引</span>
                        </label>
                        {!indexCapabilities.autoIndexes ? (
                          <small id="index-auto-unavailable">
                            {trainingType !== 'chunk'
                              ? '分段训练时可用。'
                              : modelsQuery.isLoading
                                ? '正在检查模型能力。'
                                : '没有已授权的文本模型，暂时无法启用。'}
                          </small>
                        ) : null}
                      </div>
                      <div className="kb2-index-enhancement">
                        <label className="kb2-checkbox-row">
                          <input
                            type="checkbox"
                            aria-label="标题加入索引"
                            aria-describedby={
                              indexCapabilities.indexPrefixTitle
                                ? undefined
                                : 'index-title-unavailable'
                            }
                            checked={indexPrefixTitle}
                            disabled={!indexCapabilities.indexPrefixTitle}
                            onChange={(event) => {
                              setIndexPrefixTitle(event.target.checked);
                              invalidateUrlPreviews();
                            }}
                          />
                          <span>标题加入索引</span>
                        </label>
                        {!indexCapabilities.indexPrefixTitle ? (
                          <small id="index-title-unavailable">
                            {autoIndexes && indexCapabilities.autoIndexes
                              ? '补充索引当前不可用，标题增强已清除。'
                              : '启用自动生成补充索引后可用。'}
                          </small>
                        ) : null}
                      </div>
                      <div className="kb2-index-enhancement">
                        <label className="kb2-checkbox-row">
                          <input
                            type="checkbox"
                            aria-label="图片自动索引"
                            aria-describedby={
                              indexCapabilities.imageIndex ? undefined : 'index-image-unavailable'
                            }
                            checked={imageIndex}
                            disabled={!indexCapabilities.imageIndex}
                            onChange={(event) => {
                              setImageIndex(event.target.checked);
                              invalidateUrlPreviews();
                            }}
                          />
                          <span>图片自动索引</span>
                        </label>
                        {!indexCapabilities.imageIndex ? (
                          <small id="index-image-unavailable">
                            {trainingType !== 'chunk'
                              ? '分段训练时可用。'
                              : modelsQuery.isLoading
                                ? '正在检查视觉模型能力。'
                                : '需要已授权的 VLM 和视觉或 Caption Embedding 模型。'}
                          </small>
                        ) : null}
                      </div>
                    </div>
                    {trainingType === 'qa' ? (
                      <ProductField label="QA Prompt">
                        <ProductTextarea
                          value={qaPrompt}
                          maxLength={20000}
                          placeholder="留空时使用系统 QA Prompt"
                          onChange={(event) => setQaPrompt(event.target.value)}
                        />
                      </ProductField>
                    ) : null}
                    {trainingType === 'qa' ? (
                      <div className="kb2-note" role="status" aria-label="QA 状态说明">
                        {'QA 成功'}会写入问答 Segment；无效输出使用{'原文回退'}
                        ；模型或权限失败保持{'QA 失败'}，不会伪装成成功。
                      </div>
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
              ) : kind === 'local' || kind === 'image' ? (
                <section className="kb2-local-file-preview" aria-label="本地文件分块预览">
                  <div className="kb2-local-file-list">
                    <header>
                      <strong>文件列表</strong>
                      <small>{completedUploads.length} 个文件</small>
                    </header>
                    <div role="listbox" aria-label="选择要预览的文件">
                      {completedUploads.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          role="option"
                          aria-selected={localPreviewUploadId === item.id}
                          className={
                            localPreviewUploadId === item.id
                              ? 'kb2-local-file-row is-selected'
                              : 'kb2-local-file-row'
                          }
                          onClick={() => setLocalPreviewUploadId(item.id)}
                        >
                          <AttachmentIcon boxSize={4} />
                          <span>{item.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="kb2-local-chunk-preview">
                    <header>
                      <strong>分块预览</strong>
                      <small>
                        {localFilePreviewQuery.data
                          ? `共 ${localFilePreviewQuery.data.totalChunks} 个分块，最多展示 ${localFilePreviewQuery.data.chunks.length} 个`
                          : '选择文件后加载'}
                      </small>
                    </header>
                    <ProductError
                      error={localFilePreviewQuery.error}
                      onRetry={() => void localFilePreviewQuery.refetch()}
                    />
                    <div ref={localPreviewScrollRef} className="kb2-local-chunk-scroll">
                      {!localPreviewUploadId ? (
                        <ProductEmpty
                          title="尚未选择文件"
                          description="从左侧文件列表选择一个文件查看真实分块。"
                        />
                      ) : localFilePreviewQuery.isLoading ? (
                        <div className="kb2-center-state" role="status">
                          <Spinner size="sm" /> 正在解析并生成分块…
                        </div>
                      ) : localFilePreviewQuery.data ? (
                        localFilePreviewQuery.data.totalChunks === 0 ? (
                          <div className="kb2-error-panel" role="alert">
                            <WarningIcon boxSize={4} />
                            <div>
                              <strong>没有生成分块</strong>
                              <span>请返回参数设置调整解析方式或分块条件后重试。</span>
                            </div>
                          </div>
                        ) : (
                          <div className="kb2-chunk-preview-list">
                            {localFilePreviewQuery.data.chunks.map((chunk) => (
                              <article className="kb2-chunk-preview" key={chunk.index}>
                                <span>#{chunk.index + 1}</span>
                                <S7MarkdownRenderer>{chunk.text}</S7MarkdownRenderer>
                              </article>
                            ))}
                          </div>
                        )
                      ) : (
                        <div className="kb2-note">
                          {localPreviewUpload?.name ?? '文件'} 尚未生成可预览内容。
                        </div>
                      )}
                    </div>
                  </div>
                </section>
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
              ) : kind === 'url' ? (
                <section aria-label="URL 分块预览">
                  {!urlEntries.some(
                    (entry) =>
                      entry.phase === 'ready' &&
                      entry.preview &&
                      entry.previewSignature === urlPreviewSignature,
                  ) ? (
                    <div className="kb2-note">请先预览：逐个抓取网页后继续。</div>
                  ) : null}
                  <div className="kb2-url-preview-list">
                    {urlEntries.map((entry) => {
                      const preview = entry.preview;
                      const errorView = entry.error ? productErrorView(entry.error) : null;
                      return (
                        <article
                          className="kb2-url-preview"
                          data-testid="b10-url-preview-row"
                          key={entry.id}
                        >
                          <header>
                            <div>
                              <strong>{preview?.title ?? entry.url}</strong>
                              <small>{entry.url}</small>
                            </div>
                            <StatusTag
                              value={
                                entry.phase === 'ready'
                                  ? '已预览'
                                  : entry.phase === 'previewing'
                                    ? '抓取中'
                                    : entry.phase === 'error'
                                      ? '失败'
                                      : '等待预览'
                              }
                              tone={
                                entry.phase === 'ready'
                                  ? 'success'
                                  : entry.phase === 'error'
                                    ? 'danger'
                                    : entry.phase === 'previewing'
                                      ? 'info'
                                      : 'neutral'
                              }
                            />
                            <ProductButton
                              size="sm"
                              busy={entry.phase === 'previewing'}
                              onClick={() => void previewUrl(entry)}
                            >
                              {preview ? '重新预览' : '预览'}
                            </ProductButton>
                          </header>
                          <ProductError error={entry.error} />
                          {preview ? (
                            <>
                              <div className="kb2-info-group">
                                <InfoRow label="安全 URL" value={preview.safeUrl} />
                                <InfoRow label="正文选择器" value={preview.selector} />
                                <InfoRow label="分块数量" value={String(preview.totalChunks)} />
                                <InfoRow label="正文哈希" value={preview.contentHash} />
                              </div>
                              <div className="kb2-chunk-preview-list">
                                {preview.chunks.map((chunk, index) => (
                                  <article
                                    className="kb2-chunk-preview"
                                    key={`${entry.id}:${index}`}
                                  >
                                    <span>#{index + 1}</span>
                                    <S7MarkdownRenderer>{chunk.q}</S7MarkdownRenderer>
                                  </article>
                                ))}
                              </div>
                              {preview.truncated ? (
                                <p className="kb2-table-muted">
                                  仅展示前 {preview.chunks.length} 个分块。
                                </p>
                              ) : null}
                            </>
                          ) : errorView ? (
                            <p className="kb2-table-muted">
                              {errorView.code}
                              {errorView.traceId ? ` · Trace ${errorView.traceId}` : ''}
                            </p>
                          ) : null}
                        </article>
                      );
                    })}
                  </div>
                </section>
              ) : kind === 'template' || kind === 'backup' ? (
                <section aria-label="结构化导入预览">
                  <ProductError
                    error={structuredPreviewQuery.error}
                    onRetry={() => void structuredPreviewQuery.refetch()}
                  />
                  {structuredPreviewQuery.isLoading ? (
                    <div className="kb2-center-state">正在解析文件并生成逐行预览…</div>
                  ) : structuredPreviewQuery.data ? (
                    <>
                      <div className="kb2-info-group">
                        <InfoRow
                          label="格式"
                          value={structuredPreviewQuery.data.format.toUpperCase()}
                        />
                        <InfoRow
                          label="有效数据行"
                          value={String(structuredPreviewQuery.data.rowCount)}
                        />
                        {kind === 'backup' ? (
                          <InfoRow
                            label="冲突"
                            value={String(structuredPreviewQuery.data.conflicts?.length ?? 0)}
                          />
                        ) : null}
                      </div>
                      <div className="kb2-table-wrap">
                        <table className="kb2-table" aria-label="模板数据预览">
                          <thead>
                            <tr>
                              <th>行</th>
                              <th>q</th>
                              <th>a</th>
                              <th>index</th>
                              <th>metadata</th>
                            </tr>
                          </thead>
                          <tbody>
                            {structuredPreviewQuery.data.rows.map((row) => (
                              <tr key={row.rowNumber}>
                                <td>{row.rowNumber}</td>
                                <td>{row.question}</td>
                                <td>{row.answer}</td>
                                <td>{row.indexes.join(' | ')}</td>
                                <td>{JSON.stringify(row.metadata)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {structuredPreviewQuery.data.rowCount === 0 ? (
                        <div className="kb2-note">文件只有合法表头，不会创建虚构数据行。</div>
                      ) : null}
                      {structuredPreviewQuery.data.truncated ? (
                        <div className="kb2-table-muted">仅展示前 100 行。</div>
                      ) : null}
                    </>
                  ) : (
                    <ProductEmpty title="没有可预览内容" description="返回检查上传文件。" />
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
              {jobId ? (
                <div className="kb2-note" role="status">
                  导入任务已提交：{jobId}
                </div>
              ) : null}
              {kind === 'url' ? (
                <section aria-label="网页导入状态" className="kb2-url-submit-list">
                  {urlEntries.map((entry) => (
                    <article
                      className="kb2-url-submit-row"
                      data-testid="b10-url-submit-row"
                      key={entry.id}
                    >
                      <div>
                        <strong>{entry.preview?.title ?? entry.url}</strong>
                        <small>{entry.url}</small>
                      </div>
                      <StatusTag
                        value={
                          entry.phase === 'finished'
                            ? '完成'
                            : entry.phase === 'creating'
                              ? '创建中'
                              : entry.phase === 'error'
                                ? '错误'
                                : '等待中'
                        }
                        tone={
                          entry.phase === 'finished'
                            ? 'success'
                            : entry.phase === 'creating'
                              ? 'info'
                              : entry.phase === 'error'
                                ? 'danger'
                                : 'neutral'
                        }
                      />
                      {entry.jobId ? <code>{entry.jobId}</code> : null}
                      <ProductError error={entry.error} />
                    </article>
                  ))}
                </section>
              ) : null}
              {!jobId ? (
                <>
                  <ProductEmpty
                    title={
                      kind === 'url'
                        ? urlEntries.every((entry) => entry.phase === 'finished')
                          ? '网页导入完成'
                          : urlEntries.some((entry) => entry.phase === 'finished')
                            ? '网页导入部分完成'
                            : '准备提交网页导入'
                        : '准备提交导入'
                    }
                    description={
                      kind === 'url'
                        ? `完成 ${urlEntries.filter((entry) => entry.phase === 'finished').length} / ${urlEntries.length}；只重试失败或等待项。`
                        : '提交后以服务端返回的 Job ID、状态和进度为准。'
                    }
                    action={
                      <div className="kb2-inline-actions">
                        {kind === 'url' &&
                        urlEntries.some((entry) => entry.phase === 'error') &&
                        !urlEntries.some((entry) => entry.phase === 'finished') ? (
                          <ProductButton
                            disabled={busy}
                            onClick={() => {
                              setStep(1);
                              setSubmitError(null);
                            }}
                          >
                            重新编辑
                          </ProductButton>
                        ) : null}
                        <ProductButton
                          tone="primary"
                          busy={busy}
                          disabled={kind === 'retraining'}
                          onClick={() => {
                            if (
                              kind === 'url' &&
                              urlEntries.every((entry) => entry.phase === 'finished')
                            ) {
                              props.onExit();
                              return;
                            }
                            void submit();
                          }}
                        >
                          {kind === 'url' && urlEntries.every((entry) => entry.phase === 'finished')
                            ? '返回 Collection'
                            : kind === 'url' &&
                                urlEntries.some((entry) => entry.phase === 'finished')
                              ? '继续上传'
                              : kind === 'url'
                                ? '开始上传'
                                : '确认导入'}
                        </ProductButton>
                      </div>
                    }
                  />
                  <ProductError error={submitError} />
                </>
              ) : (
                <JobResultView
                  job={jobQuery.data}
                  loading={jobQuery.isLoading}
                  error={jobQuery.error}
                  onConfirmRestore={kind === 'backup' ? confirmDryRunRestore : undefined}
                  onResetPlan={() => {
                    setJobId('');
                    setStep(1);
                  }}
                  restoreBusy={busy}
                  conflictStrategy={conflictStrategy}
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
            {step === 1 && (kind === 'api' || isConnectorKind(kind)) ? (
              <ProductButton
                tone="primary"
                busy={busy}
                disabled={!uploadsReady}
                onClick={() => void submit()}
              >
                提交导入
              </ProductButton>
            ) : null}
            {step < 3 ? (
              <ProductButton
                tone="primary"
                disabled={
                  (step === 0 && directSelection && kind === 'local' && !uploadsReady) ||
                  (step === 1 && !uploadsReady) ||
                  (step === 2 && !previewReady)
                }
                onClick={advanceStep}
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

function ProcessingSettings(props: {
  kind: ImportKind;
  customPdfParse: boolean;
  setCustomPdfParse: Dispatch<SetStateAction<boolean>>;
  trainingType: 'chunk' | 'qa' | 'imageParse';
  setTrainingType: Dispatch<SetStateAction<'chunk' | 'qa' | 'imageParse'>>;
  chunkSettingMode: 'auto' | 'custom';
  setChunkSettingMode: Dispatch<SetStateAction<'auto' | 'custom'>>;
  chunkTriggerType: 'minSize' | 'forceChunk' | 'maxSize';
  setChunkTriggerType: Dispatch<SetStateAction<'minSize' | 'forceChunk' | 'maxSize'>>;
  chunkTriggerMinSize: string;
  setChunkTriggerMinSize: Dispatch<SetStateAction<string>>;
  chunkSplitMode: 'paragraph' | 'size' | 'char';
  setChunkSplitMode: Dispatch<SetStateAction<'paragraph' | 'size' | 'char'>>;
  chunkSize: string;
  setChunkSize: Dispatch<SetStateAction<string>>;
  chunkSplitter: string;
  setChunkSplitter: Dispatch<SetStateAction<string>>;
  paragraphChunkAIMode: 'auto' | 'force' | 'forbid';
  setParagraphChunkAIMode: Dispatch<SetStateAction<'auto' | 'force' | 'forbid'>>;
  paragraphChunkDeep: string;
  setParagraphChunkDeep: Dispatch<SetStateAction<string>>;
  indexSize: string;
  setIndexSize: Dispatch<SetStateAction<string>>;
  indexSizeOptions: number[];
  maxChunkSize: number;
  autoIndexes: boolean;
  setAutoIndexes: Dispatch<SetStateAction<boolean>>;
  imageIndex: boolean;
  setImageIndex: Dispatch<SetStateAction<boolean>>;
  indexPrefixTitle: boolean;
  setIndexPrefixTitle: Dispatch<SetStateAction<boolean>>;
  indexCapabilities: {
    autoIndexes: boolean;
    indexPrefixTitle: boolean;
    imageIndex: boolean;
  };
  modelsLoading: boolean;
  qaPrompt: string;
  setQaPrompt: Dispatch<SetStateAction<string>>;
  onInvalidate: () => void;
}) {
  const showFileParsing = props.kind === 'local' || props.kind === 'image';
  const isChunk = props.trainingType === 'chunk';
  return (
    <div className="kb2-import-settings">
      {showFileParsing ? (
        <details className="kb2-settings-section" open>
          <summary>
            <span>
              <i aria-hidden="true" />
              文件解析设置
            </span>
            <span aria-hidden="true">⌄</span>
          </summary>
          <div className="kb2-settings-section__body">
            <label className="kb2-parse-card">
              <input
                type="checkbox"
                checked={props.customPdfParse}
                onChange={(event) => {
                  props.setCustomPdfParse(event.target.checked);
                  props.onInvalidate();
                }}
              />
              <span>
                <strong>PDF 增强解析</strong>
                <small>提升复杂 PDF 中表格、扫描页和版面内容的解析效果。</small>
              </span>
            </label>
          </div>
        </details>
      ) : null}

      <details className="kb2-settings-section" open>
        <summary>
          <span>
            <i aria-hidden="true" />
            数据处理方式设置
          </span>
          <span aria-hidden="true">⌄</span>
        </summary>
        <div className="kb2-settings-section__body">
          <div className="kb2-setting-label">处理方式</div>
          <div className="kb2-choice-grid" role="radiogroup" aria-label="处理方式">
            <label className={isChunk ? 'kb2-choice-card is-selected' : 'kb2-choice-card'}>
              <input
                type="radio"
                name="training-type"
                value="chunk"
                checked={isChunk}
                onChange={() => {
                  props.setTrainingType('chunk');
                  props.onInvalidate();
                }}
              />
              <span>
                <strong>分块存储</strong>
                <small>按规则切分原文并建立索引</small>
              </span>
            </label>
            {props.kind !== 'image' ? (
              <label
                className={
                  props.trainingType === 'qa' ? 'kb2-choice-card is-selected' : 'kb2-choice-card'
                }
              >
                <input
                  type="radio"
                  name="training-type"
                  value="qa"
                  checked={props.trainingType === 'qa'}
                  onChange={() => {
                    props.setTrainingType('qa');
                    props.onInvalidate();
                  }}
                />
                <span>
                  <strong>问答对提取</strong>
                  <small>由文本模型从原文生成问答对</small>
                </span>
              </label>
            ) : null}
          </div>

          {isChunk ? (
            <div className="kb2-setting-row">
              <div>
                <label htmlFor="kb2-chunk-trigger">分块条件</label>
              </div>
              <div className="kb2-setting-row__controls">
                <ProductSelect
                  id="kb2-chunk-trigger"
                  value={props.chunkTriggerType}
                  onChange={(event) => {
                    props.setChunkTriggerType(
                      event.target.value as 'minSize' | 'forceChunk' | 'maxSize',
                    );
                    props.onInvalidate();
                  }}
                >
                  <option value="minSize">原文长度大于</option>
                  <option value="maxSize">原文长度小于</option>
                  <option value="forceChunk">强制分块</option>
                </ProductSelect>
                {props.chunkTriggerType === 'minSize' ? (
                  <ProductInput
                    aria-label="分块条件值"
                    type="number"
                    min={1}
                    max={100_000}
                    value={props.chunkTriggerMinSize}
                    onChange={(event) => {
                      props.setChunkTriggerMinSize(event.target.value);
                      props.onInvalidate();
                    }}
                  />
                ) : null}
              </div>
            </div>
          ) : null}

          {isChunk || props.kind === 'image' ? (
            <div className="kb2-setting-block">
              <div className="kb2-setting-label">索引增强</div>
              <div className="kb2-index-enhancements">
                <label className="kb2-checkbox-row">
                  <input
                    type="checkbox"
                    checked={props.indexPrefixTitle}
                    disabled={!props.indexCapabilities.indexPrefixTitle}
                    onChange={(event) => {
                      props.setIndexPrefixTitle(event.target.checked);
                      props.onInvalidate();
                    }}
                  />
                  <span>将标题加入索引</span>
                </label>
                <label className="kb2-checkbox-row">
                  <input
                    type="checkbox"
                    checked={props.autoIndexes}
                    disabled={!props.indexCapabilities.autoIndexes}
                    onChange={(event) => {
                      props.setAutoIndexes(event.target.checked);
                      if (!event.target.checked) props.setIndexPrefixTitle(false);
                      props.onInvalidate();
                    }}
                  />
                  <span>自动生成补充索引</span>
                </label>
                <label className="kb2-checkbox-row">
                  <input
                    type="checkbox"
                    checked={props.imageIndex}
                    disabled={!props.indexCapabilities.imageIndex}
                    onChange={(event) => {
                      props.setImageIndex(event.target.checked);
                      props.onInvalidate();
                    }}
                  />
                  <span>图片自动索引</span>
                </label>
              </div>
            </div>
          ) : null}

          {isChunk ? (
            <div className="kb2-setting-block">
              <div className="kb2-setting-label">分块处理参数</div>
              <div className="kb2-parameter-modes" role="radiogroup" aria-label="分块处理参数">
                <label
                  className={
                    props.chunkSettingMode === 'auto'
                      ? 'kb2-parameter-card is-selected'
                      : 'kb2-parameter-card'
                  }
                >
                  <input
                    type="radio"
                    name="chunk-setting-mode"
                    value="auto"
                    checked={props.chunkSettingMode === 'auto'}
                    onChange={() => {
                      props.setChunkSettingMode('auto');
                      props.onInvalidate();
                    }}
                  />
                  <span>
                    <strong>默认</strong>
                    <small>使用系统默认的参数和规则</small>
                  </span>
                </label>
                <label
                  className={
                    props.chunkSettingMode === 'custom'
                      ? 'kb2-parameter-card is-selected'
                      : 'kb2-parameter-card'
                  }
                >
                  <input
                    type="radio"
                    name="chunk-setting-mode"
                    value="custom"
                    checked={props.chunkSettingMode === 'custom'}
                    onChange={() => {
                      props.setChunkSettingMode('custom');
                      props.onInvalidate();
                    }}
                  />
                  <span>
                    <strong>自定义</strong>
                    <small>自定义设置数据处理规则</small>
                  </span>
                </label>
              </div>

              {props.chunkSettingMode === 'custom' ? (
                <div className="kb2-custom-parameters">
                  <div className="kb2-setting-label">切分方式</div>
                  <div className="kb2-inline-radio" role="radiogroup" aria-label="切分方式">
                    {[
                      ['paragraph', '按段落分块'],
                      ['size', '按长度分块'],
                      ['char', '按指定分隔符分块'],
                    ].map(([value, label]) => (
                      <label key={value}>
                        <input
                          type="radio"
                          name="chunk-split-mode"
                          value={value}
                          checked={props.chunkSplitMode === value}
                          onChange={() => {
                            props.setChunkSplitMode(value as 'paragraph' | 'size' | 'char');
                            props.onInvalidate();
                          }}
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>

                  {props.chunkSplitMode === 'paragraph' ? (
                    <div className="kb2-custom-fields">
                      <ProductField label="模型识别段落">
                        <ProductSelect
                          value={props.paragraphChunkAIMode}
                          onChange={(event) => {
                            props.setParagraphChunkAIMode(
                              event.target.value as 'auto' | 'force' | 'forbid',
                            );
                            props.onInvalidate();
                          }}
                        >
                          <option value="forbid">禁用</option>
                          <option value="auto">自动</option>
                          <option value="force">强制</option>
                        </ProductSelect>
                      </ProductField>
                      <ProductField label="最大段落深度">
                        <ProductInput
                          type="number"
                          min={1}
                          max={8}
                          value={props.paragraphChunkDeep}
                          onChange={(event) => {
                            props.setParagraphChunkDeep(event.target.value);
                            props.onInvalidate();
                          }}
                        />
                      </ProductField>
                      <ProductField label="最大分块大小">
                        <ProductInput
                          type="number"
                          min={64}
                          max={props.maxChunkSize}
                          value={props.chunkSize}
                          onChange={(event) => {
                            props.setChunkSize(event.target.value);
                            props.onInvalidate();
                          }}
                        />
                      </ProductField>
                    </div>
                  ) : null}

                  {props.chunkSplitMode === 'size' ? (
                    <div className="kb2-custom-fields">
                      <ProductField label="分块大小">
                        <ProductInput
                          type="number"
                          min={64}
                          max={props.maxChunkSize}
                          value={props.chunkSize}
                          onChange={(event) => {
                            props.setChunkSize(event.target.value);
                            props.onInvalidate();
                          }}
                        />
                      </ProductField>
                    </div>
                  ) : null}

                  {props.chunkSplitMode === 'char' ? (
                    <div className="kb2-custom-fields">
                      <ProductField label="自定义分隔符">
                        <ProductTextarea
                          value={props.chunkSplitter}
                          placeholder="每行一个正则分隔符"
                          maxLength={1000}
                          onChange={(event) => {
                            props.setChunkSplitter(event.target.value);
                            props.onInvalidate();
                          }}
                        />
                      </ProductField>
                    </div>
                  ) : null}

                  <ProductField label="索引大小">
                    <ProductSelect
                      value={props.indexSize}
                      onChange={(event) => {
                        props.setIndexSize(event.target.value);
                        props.onInvalidate();
                      }}
                    >
                      {props.indexSizeOptions.map((size) => (
                        <option key={size} value={size}>
                          {size}
                        </option>
                      ))}
                    </ProductSelect>
                  </ProductField>
                </div>
              ) : null}
            </div>
          ) : null}

          {props.trainingType === 'qa' ? (
            <div className="kb2-setting-block">
              <ProductField label="QA Prompt">
                <ProductTextarea
                  value={props.qaPrompt}
                  maxLength={20000}
                  placeholder="留空时使用系统 QA Prompt"
                  onChange={(event) => {
                    props.setQaPrompt(event.target.value);
                    props.onInvalidate();
                  }}
                />
              </ProductField>
              <div className="kb2-note" role="status" aria-label="QA 状态说明">
                QA 成功会写入问答 Segment；无效输出使用原文回退；模型或权限失败保持 QA
                失败，不会伪装成成功。
              </div>
            </div>
          ) : null}
        </div>
      </details>
    </div>
  );
}

function CatalogSelector(props: {
  items: CatalogItem[];
  selected: string[];
  onSelect: (ids: string[]) => void;
  path: Array<{ id: string; name: string }>;
  existingIds: string[];
  onNavigate: (path: Array<{ id: string; name: string }>) => void;
}) {
  const [search, setSearch] = useState('');
  const existingIds = new Set(props.existingIds);
  const visibleItems = props.items.filter((item) =>
    item.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  const selectableItems = visibleItems.filter(
    (item) => item.type === 'directory' || !existingIds.has(item.id),
  );
  const allSelected =
    selectableItems.length > 0 && selectableItems.every((item) => props.selected.includes(item.id));
  const toggle = (id: string, checked: boolean) => {
    props.onSelect(
      checked
        ? [...new Set([...props.selected, id])]
        : props.selected.filter((selectedId) => selectedId !== id),
    );
  };
  return (
    <div className="kb2-catalog-list">
      <nav className="kb2-catalog-breadcrumb" aria-label="目录路径">
        <button
          type="button"
          onClick={() => props.onNavigate([])}
          aria-current={props.path.length === 0 ? 'page' : undefined}
        >
          根目录
        </button>
        {props.path.map((entry, index) => (
          <span key={entry.id}>
            <span aria-hidden>/</span>
            <button
              type="button"
              onClick={() => props.onNavigate(props.path.slice(0, index + 1))}
              aria-current={index === props.path.length - 1 ? 'page' : undefined}
            >
              {entry.name}
            </button>
          </span>
        ))}
      </nav>
      <ProductInput
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="搜索当前目录"
        aria-label="搜索当前目录"
      />
      {props.items.length === 0 ? (
        <div className="kb2-center-state">尚未读取目录</div>
      ) : (
        <>
          <label className="kb2-catalog-row kb2-catalog-row--select-all">
            <input
              type="checkbox"
              checked={allSelected}
              disabled={selectableItems.length === 0}
              onChange={(event) => {
                const ids = new Set(props.selected);
                for (const item of selectableItems) {
                  if (event.target.checked) ids.add(item.id);
                  else ids.delete(item.id);
                }
                props.onSelect([...ids]);
              }}
              aria-label="全选当前目录"
            />
            <strong>全选当前目录</strong>
          </label>
          {visibleItems.map((item) => (
            <div className="kb2-catalog-row" key={`${item.type}-${item.id}`}>
              {item.type === 'directory' ? (
                <>
                  <input
                    type="checkbox"
                    checked={props.selected.includes(item.id)}
                    onChange={(event) => toggle(item.id, event.target.checked)}
                    aria-label={`选择目录 ${item.name}`}
                  />
                  <ProductTypeIcon kind="folder" />
                  <span>{item.name}</span>
                  <ProductButton
                    size="sm"
                    aria-label={`进入目录 ${item.name}`}
                    onClick={() =>
                      props.onNavigate([...props.path, { id: item.id, name: item.name }])
                    }
                  >
                    进入目录
                  </ProductButton>
                </>
              ) : (
                <>
                  <input
                    type="checkbox"
                    checked={props.selected.includes(item.id)}
                    disabled={existingIds.has(item.id)}
                    onChange={(event) => toggle(item.id, event.target.checked)}
                    aria-label={`选择 ${item.name}`}
                  />
                  <span>{item.name}</span>
                  <small>{existingIds.has(item.id) ? '已导入' : '文件'}</small>
                </>
              )}
            </div>
          ))}
          {visibleItems.length === 0 ? (
            <div className="kb2-center-state">当前目录没有匹配项</div>
          ) : null}
        </>
      )}
    </div>
  );
}

function JobResultView(props: {
  job?: Job;
  loading: boolean;
  error: unknown;
  onConfirmRestore?: () => Promise<void>;
  onResetPlan?: () => void;
  restoreBusy?: boolean;
  conflictStrategy?: 'fail' | 'skip' | 'overwrite';
}) {
  if (props.error) return <ProductError error={props.error} />;
  if (props.loading || !props.job) {
    return <div className="kb2-center-state">正在读取服务端任务状态…</div>;
  }
  const partial = Boolean(props.job.result?.partial);
  const dryRun = props.job.result?.dryRun === true;
  const actions = Array.isArray(props.job.result?.actions)
    ? (props.job.result.actions as Array<{ rowNumber: number; action: string }>)
    : [];
  const conflicts = Array.isArray(props.job.result?.conflicts)
    ? (props.job.result.conflicts as Array<{
        rowNumber: number;
        existingSourceId: string;
        existingVersion: number;
      }>)
    : [];
  const actionCount = (action: string) => actions.filter((item) => item.action === action).length;
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
      {dryRun ? (
        <section className="kb2-job-plan" aria-label="恢复预览">
          <h4>恢复预览</h4>
          <div className="kb2-info-group">
            <InfoRow label="新增" value={String(actionCount('create'))} />
            <InfoRow label="冲突" value={String(conflicts.length)} />
            <InfoRow label="跳过" value={String(actionCount('skip'))} />
            <InfoRow label="覆盖" value={String(actionCount('overwrite'))} />
            <InfoRow label="失败" value={String(actionCount('fail'))} />
          </div>
          {conflicts.length > 0 ? (
            <div className="kb2-table-wrap">
              <table className="kb2-table" aria-label="备份冲突报告">
                <thead>
                  <tr>
                    <th>行</th>
                    <th>现有 Source</th>
                    <th>版本</th>
                  </tr>
                </thead>
                <tbody>
                  {conflicts.map((conflict) => (
                    <tr key={`${conflict.rowNumber}:${conflict.existingSourceId}`}>
                      <td>{conflict.rowNumber}</td>
                      <td>{conflict.existingSourceId}</td>
                      <td>{conflict.existingVersion}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {conflicts.length > 0 && props.conflictStrategy === 'fail' ? (
            <>
              <div className="kb2-note">存在冲突，请选择“跳过”或“覆盖”后重新预览。</div>
              <ProductButton onClick={props.onResetPlan}>返回修改策略</ProductButton>
            </>
          ) : (
            <ProductButton
              tone="primary"
              busy={props.restoreBusy}
              onClick={() => void props.onConfirmRestore?.()}
            >
              确认恢复
            </ProductButton>
          )}
        </section>
      ) : null}
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
  urlCount: number;
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
      description: `${input.urlCount} 个待导入网页`,
      rows: [{ label: 'URL 数量', value: String(input.urlCount) }],
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
