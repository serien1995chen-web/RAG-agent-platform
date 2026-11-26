'use client';

import {
  AddIcon,
  AttachmentIcon,
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  DeleteIcon,
  DownloadIcon,
  EditIcon,
  ExternalLinkIcon,
  LockIcon,
  RepeatIcon,
  WarningIcon,
} from '@chakra-ui/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from 'react';
import {
  addCollaborator,
  applyTags,
  archiveSources,
  batchSources,
  createDirectory,
  createTag,
  controlJob,
  deleteDirectory,
  deleteSource,
  deleteTag,
  downloadFileTicket,
  downloadSource,
  getAcl,
  getConnector,
  getJob,
  getSource,
  listCollaborators,
  moveDirectory,
  moveSource,
  previewFile,
  previewSource,
  ProductBatchError,
  productApi,
  productErrorView,
  removeCollaborator,
  transitionSourcePermission,
  updateAcl,
  updateDirectory,
  updateSource,
  updateSpace,
  updateModelBindings,
  syncConnector,
  updateTag,
} from './api';
import {
  canOpenTrainingState,
  directoryPath,
  descendantDirectoryIds,
  filterSourceRows,
  formatTagValueKey,
  formatSourceTime,
  hasActiveSourceStatus,
  jobStageLabel,
  latestJobsByResource,
  normalizeDetailTab,
  processingModelLabel,
  sourceStatusView,
  tagValuesForSource,
  type DetailTab,
} from './dataset-detail-state';
import { ProductAppShell } from './shell';
import type {
  Acl,
  BatchResult,
  Collaborator,
  Directory,
  Job,
  KnowledgeSpace,
  Model,
  ModelBinding,
  PermissionLevel,
  Source,
  Tag,
} from './types';
import { jobActionsFor, type S6JobAction } from '../components/s6-jobs-panel';
import {
  ProductButton,
  ProductCheckbox,
  ProductEmpty,
  ProductError,
  ProductField,
  ProductIconButton,
  ProductInput,
  ProductMenu,
  ProductMenuItem,
  ProductModal,
  ProductPage,
  ProductPageHeader,
  ProductSearchBox,
  ProductSelect,
  ProductSkeleton,
  ProductTypeIcon,
  StatusTag,
  formatDate,
  productTypeOf,
  useProductToast,
} from './ui';
import { DataWorkspace } from './data-workspace';
import { CollaboratorManagerDialog } from './collaborator-manager';
import { ImportWorkspace } from './import-workspace';
import {
  EmptySourceDialog,
  ImageDatasetDialog,
  StructuredImportDialog,
  TextSourceDialog,
  type StructuredImportKind,
  type TextImportSource,
} from './import-entry-dialogs';
import { SearchWorkspace } from './search-workspace';
import { modelsForRole, type KnowledgeModelRole } from './model-candidates';
import { ModelSelect } from './model-selector';

export interface DatasetDetailQuery {
  datasetId: string;
  currentTab?: string;
  parentId?: string;
  collectionId?: string;
  source?: string;
  importJobId?: string;
}

type DetailQueryChange = (query: DatasetDetailQuery, options?: { replace?: boolean }) => void;

const MODEL_REBUILD_CONFIRM_SECONDS = 3;

type SourcePreviewView =
  | { kind: 'image'; url: string; expiresAt: string }
  | {
      kind: 'text';
      sections: Array<{ title?: string; text: string; page?: number }>;
    };

interface TagAssignmentRow {
  id: string;
  tagId: string;
  value: string;
  existing: boolean;
}

function permissionRank(permission: PermissionLevel | null | undefined): number {
  return permission ? { read: 10, write: 20, manage: 30, owner: 40 }[permission] : 0;
}

export function DatasetDetailPage(props: {
  query: DatasetDetailQuery;
  onQueryChange: DetailQueryChange;
}) {
  const toast = useProductToast();
  const queryClient = useQueryClient();
  const tab = normalizeDetailTab(props.query.currentTab);
  const datasetId = props.query.datasetId;
  const currentDirectoryId = props.query.parentId ?? '';
  const [search, setSearch] = useState('');
  const [tagId, setTagId] = useState('');
  const [tagValue, setTagValue] = useState('');
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const [textSourceDialogOpen, setTextSourceDialogOpen] = useState(false);
  const [emptyDatasetOpen, setEmptyDatasetOpen] = useState(false);
  const [imageDatasetOpen, setImageDatasetOpen] = useState(false);
  const [structuredImportKind, setStructuredImportKind] = useState<StructuredImportKind | null>(
    null,
  );
  const [batchMode, setBatchMode] = useState(false);
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [rowMenuId, setRowMenuId] = useState<string | null>(null);
  const [rowMenuInitialFocus, setRowMenuInitialFocus] = useState<'first' | 'last' | null>(null);
  const [rowMenuTriggerElement, setRowMenuTriggerElement] = useState<HTMLButtonElement | null>(
    null,
  );
  const [previewSourceTarget, setPreviewSourceTarget] = useState<Source | null>(null);
  const [previewRequest, setPreviewRequest] = useState(0);
  const [previewTriggerElement, setPreviewTriggerElement] = useState<HTMLButtonElement | null>(
    null,
  );
  const [sourceToggleBusyId, setSourceToggleBusyId] = useState<string | null>(null);
  const [sourceSyncBusyId, setSourceSyncBusyId] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<unknown>(null);
  const [renameSourceTarget, setRenameSourceTarget] = useState<Source | null>(null);
  const [directoryForm, setDirectoryForm] = useState<{
    mode: 'create' | 'edit';
    directory?: Directory;
  } | null>(null);
  const [directoryName, setDirectoryName] = useState('');
  const [directoryBusy, setDirectoryBusy] = useState(false);
  const [directoryError, setDirectoryError] = useState<unknown>(null);
  const [deleteDirectoryTarget, setDeleteDirectoryTarget] = useState<Directory | null>(null);
  const [deleteSourceTarget, setDeleteSourceTarget] = useState<Source | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<unknown>(null);
  const [moveSourceTarget, setMoveSourceTarget] = useState<Source | null>(null);
  const [moveDirectoryTarget, setMoveDirectoryTarget] = useState<Directory | null>(null);
  const [moveTargetId, setMoveTargetId] = useState('');
  const [moveBusy, setMoveBusy] = useState(false);
  const [moveError, setMoveError] = useState<unknown>(null);
  const [batchDialog, setBatchDialog] = useState<'tag' | 'delete' | null>(null);
  const [batchTagId, setBatchTagId] = useState('');
  const [batchTagValue, setBatchTagValue] = useState('');
  const [batchDeleteText, setBatchDeleteText] = useState('');
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchError, setBatchError] = useState<unknown>(null);
  const [batchResult, setBatchResult] = useState<BatchResult | null>(null);
  const [archiveStage, setArchiveStage] = useState<'idle' | 'queued' | 'running' | 'ready'>('idle');
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const [tagAssignmentTarget, setTagAssignmentTarget] = useState<Source | null>(null);
  const [tagAssignmentRows, setTagAssignmentRows] = useState<TagAssignmentRow[]>([]);
  const [removedTagIds, setRemovedTagIds] = useState<string[]>([]);
  const [tagAssignmentBusy, setTagAssignmentBusy] = useState(false);
  const [tagAssignmentError, setTagAssignmentError] = useState<unknown>(null);
  const [permissionTarget, setPermissionTarget] = useState<{
    kind: 'space' | 'directory' | 'source';
    id: string;
    name: string;
    version: number;
    source?: Source;
  } | null>(null);
  const [editDatasetOpen, setEditDatasetOpen] = useState(false);
  const [editDatasetName, setEditDatasetName] = useState('');
  const [editDatasetDescription, setEditDatasetDescription] = useState('');
  const [editDatasetBusy, setEditDatasetBusy] = useState(false);
  const [editDatasetError, setEditDatasetError] = useState<unknown>(null);
  const [trainingSource, setTrainingSource] = useState<Source | null>(null);
  const [trainingErrorOpen, setTrainingErrorOpen] = useState(false);

  const spaceQuery = useQuery({
    queryKey: ['kb-product', 'space', datasetId],
    queryFn: () => productApi.getSpace(datasetId),
    enabled: Boolean(datasetId),
  });
  const directoriesQuery = useQuery({
    queryKey: ['kb-product', 'directories', datasetId],
    queryFn: () => productApi.listDirectories(datasetId),
    enabled: Boolean(datasetId),
  });
  const sourcesQuery = useQuery({
    queryKey: ['kb-product', 'sources', datasetId],
    queryFn: () => productApi.listSources(datasetId),
    enabled: Boolean(datasetId),
    refetchInterval: (data) => (data?.some(hasActiveSourceStatus) ? 10_000 : false),
    refetchIntervalInBackground: false,
  });
  const sourcePreviewQuery = useQuery<SourcePreviewView>({
    queryKey: [
      'kb-product',
      'source-preview',
      previewSourceTarget?.id,
      previewSourceTarget?.blobRefId,
      previewRequest,
    ],
    queryFn: async () => {
      const source = previewSourceTarget!;
      if (source.mimeType?.startsWith('image/')) {
        if (!source.blobRefId) throw new Error('图片 Source 缺少可读取对象。');
        const ticket = await previewFile(source.blobRefId);
        return { kind: 'image', url: ticket.url, expiresAt: ticket.expiresAt };
      }
      return { kind: 'text', ...(await previewSource(source.id)) };
    },
    enabled: Boolean(previewSourceTarget),
  });
  const tagsQuery = useQuery({
    queryKey: ['kb-product', 'tags', datasetId],
    queryFn: () => productApi.listTags(datasetId),
    enabled: Boolean(datasetId),
  });
  const jobsQuery = useQuery({
    queryKey: ['kb-product', 'jobs', datasetId],
    queryFn: () => productApi.listJobs(),
    enabled: Boolean(datasetId),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
  const modelsQuery = useQuery({
    queryKey: ['kb-product', 'models'],
    queryFn: () => productApi.listModels(),
    enabled: Boolean(datasetId),
  });
  const bindingsQuery = useQuery({
    queryKey: ['kb-product', 'model-bindings', datasetId],
    queryFn: () => productApi.getModelBindings(datasetId),
    enabled: Boolean(datasetId),
  });

  const space = spaceQuery.data;
  const directories = directoriesQuery.data ?? [];
  const sources = sourcesQuery.data ?? [];
  const tags = tagsQuery.data ?? [];
  const jobs = jobsQuery.data ?? [];
  const models = modelsQuery.data ?? [];
  const bindings = bindingsQuery.data?.items ?? [];
  const currentDirectory = directories.find((directory) => directory.id === currentDirectoryId);
  const currentPath = directoryPath(directories, currentDirectoryId);
  const currentDirectories = useMemo(
    () =>
      directories
        .filter((directory) => (directory.parentDirectoryId ?? '') === currentDirectoryId)
        .filter((directory) =>
          search.trim()
            ? directory.name
                .toLocaleLowerCase('zh-CN')
                .includes(search.trim().toLocaleLowerCase('zh-CN'))
            : true,
        )
        .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN')),
    [currentDirectoryId, directories, search],
  );
  const currentSources = useMemo(
    () =>
      filterSourceRows(
        sources.filter((source) => (source.directoryId ?? '') === currentDirectoryId),
        { search, tagId, tagValue },
      ),
    [currentDirectoryId, search, sources, tagId, tagValue],
  );
  const selectedSources = sources.filter((source) => selectedSourceIds.includes(source.id));
  const latestJobs = useMemo(() => latestJobsByResource(jobs), [jobs]);
  const failedJobs = useMemo(
    () =>
      jobs.filter(
        (job) =>
          job.knowledgeSpaceId === datasetId && ['failed', 'dead_letter'].includes(job.status),
      ),
    [datasetId, jobs],
  );
  const selectedTag = tags.find((tag) => tag.id === tagId);
  const batchTag = tags.find((tag) => tag.id === batchTagId);

  useEffect(() => {
    if (!datasetId) {
      window.location.assign('/dataset/list');
    }
  }, [datasetId]);

  useEffect(() => {
    if (!datasetId) return;
    if (props.query.currentTab !== tab) {
      props.onQueryChange({ datasetId, currentTab: tab }, { replace: true });
    }
  }, [datasetId, props, tab]);

  useEffect(() => {
    if (!datasetId || directoriesQuery.isLoading) return;
    if (currentDirectoryId && !currentDirectory) {
      props.onQueryChange(
        {
          datasetId,
          currentTab: tab,
          ...(props.query.collectionId ? { collectionId: props.query.collectionId } : {}),
        },
        { replace: true },
      );
    }
  }, [currentDirectory, currentDirectoryId, datasetId, directoriesQuery.isLoading, props, tab]);

  useEffect(() => {
    if (spaceQuery.error && datasetId) {
      toast.error(spaceQuery.error);
      window.location.assign('/dataset/list');
    }
  }, [datasetId, spaceQuery.error, toast]);

  useEffect(() => {
    setSelectedSourceIds([]);
    setRowMenuId(null);
    setBatchResult(null);
  }, [currentDirectoryId, datasetId, search, tagId, tagValue]);

  const navigate = (next: DatasetDetailQuery, replace = false) =>
    props.onQueryChange(next, { replace });

  const invalidateCollection = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['kb-product', 'space', datasetId] }),
      queryClient.invalidateQueries({ queryKey: ['kb-product', 'directories', datasetId] }),
      queryClient.invalidateQueries({ queryKey: ['kb-product', 'sources', datasetId] }),
      queryClient.invalidateQueries({ queryKey: ['kb-product', 'tags', datasetId] }),
      queryClient.invalidateQueries({ queryKey: ['kb-product', 'jobs', datasetId] }),
    ]);
  };

  const changeTab = (next: Exclude<DetailTab, 'dataCard' | 'import'>) => {
    setBatchMode(false);
    setSelectedSourceIds([]);
    navigate({ datasetId, currentTab: next });
  };

  const openDirectory = (directory?: Directory) => {
    setDirectoryForm({ mode: directory ? 'edit' : 'create', directory });
    setDirectoryName(directory?.name ?? '');
    setDirectoryError(null);
  };

  const submitDirectory = async (event: FormEvent) => {
    event.preventDefault();
    if (!space || !directoryForm || !directoryName.trim()) return;
    setDirectoryBusy(true);
    setDirectoryError(null);
    try {
      if (directoryForm.mode === 'edit' && directoryForm.directory) {
        await updateDirectory(directoryForm.directory, directoryName.trim());
      } else {
        await createDirectory(datasetId, {
          name: directoryName.trim(),
          parentDirectoryId: currentDirectoryId || null,
        });
      }
      await invalidateCollection();
      setDirectoryForm(null);
      toast.success(directoryForm.mode === 'edit' ? '目录已更新' : '目录已创建');
    } catch (error) {
      setDirectoryError(error);
    } finally {
      setDirectoryBusy(false);
    }
  };

  const removeDirectory = async () => {
    if (!deleteDirectoryTarget) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await deleteDirectory(deleteDirectoryTarget);
      await invalidateCollection();
      setDeleteDirectoryTarget(null);
      if (deleteDirectoryTarget.id === currentDirectoryId) {
        navigate(
          {
            datasetId,
            currentTab: 'collectionCard',
            ...(deleteDirectoryTarget.parentDirectoryId
              ? { parentId: deleteDirectoryTarget.parentDirectoryId }
              : {}),
          },
          true,
        );
      }
      toast.success('目录已删除');
    } catch (error) {
      setDeleteError(error);
    } finally {
      setDeleteBusy(false);
    }
  };

  const openMoveSource = (source: Source) => {
    setRowMenuId(null);
    setMoveSourceTarget(source);
    setMoveTargetId(source.directoryId ?? '');
    setMoveError(null);
  };

  const openMoveDirectory = (directory: Directory) => {
    setMoveDirectoryTarget(directory);
    setMoveTargetId(directory.parentDirectoryId ?? '');
    setMoveError(null);
  };

  const submitSourceMove = async (event: FormEvent) => {
    event.preventDefault();
    if (!moveSourceTarget) return;
    setMoveBusy(true);
    setMoveError(null);
    try {
      await moveSource(moveSourceTarget, moveTargetId || null);
      await invalidateCollection();
      setMoveSourceTarget(null);
      toast.success('移动成功');
    } catch (error) {
      setMoveError(error);
    } finally {
      setMoveBusy(false);
    }
  };

  const submitDirectoryMove = async (event: FormEvent) => {
    event.preventDefault();
    if (!moveDirectoryTarget) return;
    setMoveBusy(true);
    setMoveError(null);
    try {
      await moveDirectory(moveDirectoryTarget, moveTargetId || null);
      await invalidateCollection();
      setMoveDirectoryTarget(null);
      toast.success('移动成功');
    } catch (error) {
      setMoveError(error);
    } finally {
      setMoveBusy(false);
    }
  };

  const toggleSource = async (source: Source, enabled: boolean) => {
    setSourceToggleBusyId(source.id);
    setSourceError(null);
    try {
      await updateSource(source, { searchEnabled: enabled });
      await invalidateCollection();
    } catch (error) {
      setSourceError(error);
      toast.error(error);
    } finally {
      setSourceToggleBusyId(null);
    }
  };

  const syncSource = async (source: Source) => {
    if (!source.connectorId) return;
    setRowMenuId(null);
    setSourceSyncBusyId(source.id);
    setSourceError(null);
    try {
      const connector = await getConnector(source.connectorId);
      await syncConnector(connector.id, {
        full: false,
        expectedCursorVersion: connector.cursorVersion,
        reason: 'manual_source_menu_sync',
      });
      await invalidateCollection();
      toast.success('同步任务已提交');
    } catch (error) {
      setSourceError(error);
      toast.error(error);
    } finally {
      setSourceSyncBusyId(null);
    }
  };

  const openRenameSource = (source: Source) => {
    setRowMenuId(null);
    setRenameSourceTarget(source);
  };

  const removeSource = async () => {
    if (!deleteSourceTarget) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await deleteSource(deleteSourceTarget);
      await invalidateCollection();
      setDeleteSourceTarget(null);
      toast.success('文件已删除');
    } catch (error) {
      setDeleteError(error);
    } finally {
      setDeleteBusy(false);
    }
  };

  const downloadOne = async (source: Source) => {
    setRowMenuId(null);
    try {
      const ticket = await downloadSource(source.id);
      window.open(ticket.url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      toast.error(error);
    }
  };

  const archiveSelected = async () => {
    if (selectedSources.length === 0) return;
    setBatchBusy(true);
    setBatchError(null);
    setArchiveStage('queued');
    try {
      const queued = await archiveSources(
        datasetId,
        selectedSources.map((source) => source.id),
      );
      let current = queued;
      const deadline = Date.now() + 120_000;
      while (current.status !== 'succeeded') {
        if (['failed', 'dead_letter', 'cancelled'].includes(current.status)) {
          throw new Error(`归档任务失败：${current.status}`);
        }
        if (Date.now() >= deadline) throw new Error('归档任务超时，请重试。');
        setArchiveStage(current.status === 'queued' ? 'queued' : 'running');
        await new Promise((resolveWait) => window.setTimeout(resolveWait, 1_000));
        current = await getJob(queued.jobId);
      }
      const blobId = current.result?.objectBlobRefId;
      if (typeof blobId !== 'string') throw new Error('归档结果缺少 export ObjectRef。');
      const ticket = await downloadFileTicket(blobId);
      const anchor = document.createElement('a');
      anchor.href = ticket.url;
      anchor.download = `knowledge-archive-${Date.now()}.zip`;
      anchor.rel = 'noopener noreferrer';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setArchiveStage('ready');
      toast.success('压缩包已开始下载');
    } catch (error) {
      setBatchError(error);
      setArchiveStage('idle');
      toast.error(error);
    } finally {
      setBatchBusy(false);
    }
  };

  const applyBatchTag = async () => {
    if (!batchTag || selectedSources.length === 0) return;
    setBatchBusy(true);
    setBatchError(null);
    try {
      const result = await applyTags(
        selectedSources.map((source) => ({
          sourceId: source.id,
          tagId: batchTag.id,
          value: parseTagInput(batchTag, batchTagValue),
        })),
        Object.fromEntries(selectedSources.map((source) => [source.id, source.version])),
      );
      await invalidateCollection();
      if (result.failed > 0) {
        setBatchError(
          new Error(
            `批量标签部分失败：成功 ${result.succeeded}，失败 ${result.failed}。请重试失败项。`,
          ),
        );
        setSelectedSourceIds(result.items.filter((item) => !item.success).map((item) => item.id));
        toast.warning('批量标签部分失败');
      } else {
        setBatchDialog(null);
        toast.success('标签设置成功');
      }
    } catch (error) {
      setBatchError(error);
    } finally {
      setBatchBusy(false);
    }
  };

  const deleteBatch = async () => {
    if (selectedSources.length === 0) return;
    const expected = selectedSources.length === 1 ? (selectedSources[0]?.name ?? '') : '确认删除';
    if (batchDeleteText !== expected) return;
    setBatchBusy(true);
    setBatchError(null);
    try {
      const result = await batchSources('delete', selectedSources);
      setBatchResult(result);
      const failedIds = result.items.filter((item) => !item.success).map((item) => item.id);
      setSelectedSourceIds(failedIds);
      await invalidateCollection();
      if (result.failed === 0) {
        setBatchDialog(null);
        setBatchMode(false);
        setBatchDeleteText('');
        toast.success('删除成功');
      } else {
        toast.warning('批量删除部分失败');
      }
    } catch (error) {
      setBatchError(error);
    } finally {
      setBatchBusy(false);
    }
  };

  const openTagAssignment = (source: Source) => {
    setRowMenuId(null);
    setTagAssignmentTarget(source);
    const rows = (source.tagValues ?? []).map((entry) => ({
      id: globalThis.crypto.randomUUID(),
      tagId: entry.tagId,
      value: formatTagValueKey(entry.value),
      existing: true,
    }));
    setTagAssignmentRows(
      rows.length > 0
        ? rows
        : [{ id: globalThis.crypto.randomUUID(), tagId: '', value: '', existing: false }],
    );
    setRemovedTagIds([]);
    setTagAssignmentError(null);
  };

  const assignSourceTag = async () => {
    if (!tagAssignmentTarget) return;
    if (
      tagAssignmentRows.some(
        (row) => !row.tagId || !row.value.trim() || !tags.some((tag) => tag.id === row.tagId),
      )
    ) {
      setTagAssignmentError(new ProductBatchError('KNOWLEDGE_VALIDATION_FAILED'));
      return;
    }
    setTagAssignmentBusy(true);
    setTagAssignmentError(null);
    try {
      const latestTags = new Map(tags.map((tag) => [tag.id, tag]));
      for (const row of tagAssignmentRows) {
        const tag = latestTags.get(row.tagId);
        if (!tag || tag.options === null) continue;
        const parsed = parseTagInput(tag, row.value);
        const values = Array.isArray(parsed) ? parsed : [parsed];
        const missing = values
          .filter((value): value is string => typeof value === 'string')
          .filter((value) => !tag.options!.includes(value));
        if (missing.length === 0) continue;
        const updated = await updateTag(tag, {
          options: [...new Set([...tag.options, ...missing])],
        });
        latestTags.set(tag.id, updated);
      }
      const items: Array<{ sourceId: string; tagId: string; value: unknown }> =
        tagAssignmentRows.map((row) => {
          const tag = latestTags.get(row.tagId)!;
          return {
            sourceId: tagAssignmentTarget.id,
            tagId: row.tagId,
            value: parseTagInput(tag, row.value),
          };
        });
      for (const tagId of removedTagIds) {
        const tag = latestTags.get(tagId);
        if (tag && !tag.required) {
          items.push({ sourceId: tagAssignmentTarget.id, tagId, value: null });
        }
      }
      const result = await applyTags(items, {
        [tagAssignmentTarget.id]: tagAssignmentTarget.version,
      });
      if (result.failed > 0) {
        throw new ProductBatchError(
          result.items.find((item) => !item.success)?.code ?? 'KNOWLEDGE_PARTIAL_SUCCESS',
        );
      }
      await Promise.all([
        invalidateCollection(),
        queryClient.invalidateQueries({ queryKey: ['kb-product', 'tags', datasetId] }),
      ]);
      setTagAssignmentTarget(null);
      toast.success('标签设置成功');
    } catch (error) {
      setTagAssignmentError(error);
      if (productErrorView(error).code === 'KNOWLEDGE_CONFLICT' && tagAssignmentTarget) {
        const [latestSource] = await Promise.all([
          getSource(tagAssignmentTarget.id),
          invalidateCollection(),
          queryClient.invalidateQueries({ queryKey: ['kb-product', 'tags', datasetId] }),
        ]);
        setTagAssignmentTarget(latestSource);
      }
    } finally {
      setTagAssignmentBusy(false);
    }
  };

  const openEditDataset = () => {
    if (!space) return;
    setEditDatasetName(space.name);
    setEditDatasetDescription(space.description ?? '');
    setEditDatasetError(null);
    setEditDatasetOpen(true);
  };

  const submitDatasetEdit = async (event: FormEvent) => {
    event.preventDefault();
    if (!space || !editDatasetName.trim()) return;
    setEditDatasetBusy(true);
    setEditDatasetError(null);
    try {
      await updateSpace(space.id, {
        version: space.version,
        name: editDatasetName.trim(),
        description: editDatasetDescription.trim(),
      });
      await invalidateCollection();
      setEditDatasetOpen(false);
      toast.success('知识库信息已更新');
    } catch (error) {
      setEditDatasetError(error);
    } finally {
      setEditDatasetBusy(false);
    }
  };

  if (!datasetId) return null;

  if (tab === 'dataCard') {
    const source = sources.find((item) => item.id === props.query.collectionId);
    return (
      <ProductAppShell active="knowledge" title={space?.name ?? '知识库'}>
        <DataWorkspace
          space={space}
          sourceId={props.query.collectionId ?? ''}
          onBack={() =>
            navigate(
              {
                datasetId,
                currentTab: 'collectionCard',
                ...(props.query.parentId ? { parentId: props.query.parentId } : {}),
              },
              true,
            )
          }
          onRetrain={() =>
            navigate(
              {
                datasetId,
                currentTab: 'import',
                ...(props.query.collectionId ? { collectionId: props.query.collectionId } : {}),
                ...(source?.directoryId ? { parentId: source.directoryId } : {}),
                source: 'reTraining',
              },
              true,
            )
          }
        />
        {!source && props.query.collectionId ? (
          <div className="kb2-note" role="alert">
            <ProductError
              error={new Error('当前 Source 不存在或已被删除。')}
              onRetry={() =>
                navigate(
                  {
                    datasetId,
                    currentTab: 'collectionCard',
                    ...(props.query.parentId ? { parentId: props.query.parentId } : {}),
                  },
                  true,
                )
              }
            />
          </div>
        ) : null}
      </ProductAppShell>
    );
  }

  if (tab === 'import') {
    return (
      <ProductAppShell active="knowledge" title={space?.name ?? '知识库'}>
        <ImportWorkspace
          spaceId={datasetId}
          datasetName={space?.name ?? '知识库'}
          initialDirectoryId={props.query.parentId}
          initialSource={props.query.source}
          collectionId={props.query.collectionId}
          initialJobId={props.query.importJobId}
          existingExternalIds={sources.flatMap((source) =>
            source.externalId ? [source.externalId] : [],
          )}
          onExit={() =>
            navigate(
              {
                datasetId,
                currentTab: 'collectionCard',
                ...(props.query.parentId ? { parentId: props.query.parentId } : {}),
              },
              true,
            )
          }
          onImported={() => {
            void invalidateCollection();
          }}
          onJobStarted={(jobId) =>
            navigate(
              {
                datasetId,
                currentTab: 'import',
                ...(props.query.parentId ? { parentId: props.query.parentId } : {}),
                ...(props.query.collectionId ? { collectionId: props.query.collectionId } : {}),
                ...(props.query.source ? { source: props.query.source } : {}),
                importJobId: jobId,
              },
              true,
            )
          }
        />
      </ProductAppShell>
    );
  }

  const loading = spaceQuery.isLoading || directoriesQuery.isLoading || sourcesQuery.isLoading;
  const allVisibleSourcesSelected =
    currentSources.length > 0 &&
    currentSources.every((source) => selectedSourceIds.includes(source.id));
  const batchDeleteConfirmation =
    selectedSources.length === 1 ? (selectedSources[0]?.name ?? '') : '确认删除';

  return (
    <ProductAppShell active="knowledge" title={space?.name ?? '知识库'}>
      <ProductPage className="kb2-detail-page">
        <ProductPageHeader
          breadcrumbs={
            <DatasetBreadcrumb
              datasetName={space?.name ?? '知识库'}
              directoryPath={currentPath}
              onRoot={() => navigate({ datasetId, currentTab: 'collectionCard' }, true)}
              onDirectory={(directory) =>
                navigate({ datasetId, currentTab: 'collectionCard', parentId: directory.id }, true)
              }
            />
          }
          title={space?.name ?? '知识库详情'}
          description={space?.description || '这个知识库还没有介绍。'}
        />

        <ProductError
          error={
            spaceQuery.error ??
            directoriesQuery.error ??
            sourcesQuery.error ??
            tagsQuery.error ??
            jobsQuery.error ??
            sourceError ??
            batchError
          }
          onRetry={() => {
            void spaceQuery.refetch();
            void directoriesQuery.refetch();
            void sourcesQuery.refetch();
            void jobsQuery.refetch();
          }}
        />

        <div className="kb2-detail-nav" role="navigation" aria-label="知识库视图">
          <div className="kb2-detail-nav__path">
            <ProductTypeIcon kind={productTypeOf(space?.iconKey).kind} />
            <span>{space?.accessMode === 'restricted' ? '受限访问' : '工作区可见'}</span>
          </div>
          <div className="kb2-detail-tabs" role="tablist" aria-label="知识库页面">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'collectionCard'}
              onClick={() => changeTab('collectionCard')}
            >
              数据集
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'test'}
              onClick={() => changeTab('test')}
            >
              搜索测试
            </button>
          </div>
        </div>

        {tab === 'test' ? (
          <div className="kb2-detail-layout">
            <section className="kb2-detail-panel">
              <SearchWorkspace
                datasetId={datasetId}
                datasetName={space?.name ?? '知识库'}
                onOpenSegment={(sourceId) =>
                  navigate({
                    datasetId,
                    currentTab: 'dataCard',
                    collectionId: sourceId,
                  })
                }
              />
            </section>
            <DatasetInfoPanel
              space={space}
              bindings={bindings}
              models={models}
              modelsError={modelsQuery.error}
              modelsLoading={modelsQuery.isLoading}
              onRetryModels={() => void modelsQuery.refetch()}
              rebuilding={jobs.some(
                (job) =>
                  job.knowledgeSpaceId === datasetId &&
                  job.kind === 'rebuild' &&
                  !['succeeded', 'failed', 'cancelled', 'dead_letter'].includes(job.status),
              )}
              onEdit={openEditDataset}
              onPermission={() =>
                space &&
                setPermissionTarget({
                  kind: 'space',
                  id: space.id,
                  name: space.name,
                  version: space.version,
                })
              }
              onChanged={() => void invalidateCollection()}
            />
          </div>
        ) : (
          <div className="kb2-detail-layout">
            <section className="kb2-detail-panel" aria-label="Collection 列表">
              <div className="kb2-collection-header">
                <div>
                  <h2>{currentDirectory?.name ?? '全部文件'}</h2>
                  <p>
                    {currentDirectories.length} 个目录 · {currentSources.length} 个文件
                  </p>
                </div>
                <div className="kb2-collection-header__actions">
                  {failedJobs.length > 0 ? (
                    <ProductButton
                      size="sm"
                      tone="danger"
                      onClick={() => setTrainingErrorOpen(true)}
                    >
                      <WarningIcon boxSize={3.5} />
                      训练异常列表
                    </ProductButton>
                  ) : null}
                  <ProductButton size="sm" onClick={() => setTagManagerOpen(true)}>
                    标签管理
                  </ProductButton>
                  <div className="kb2-new-wrap">
                    <ProductButton
                      size="sm"
                      tone="primary"
                      aria-expanded={importMenuOpen}
                      aria-haspopup="menu"
                      onClick={() => setImportMenuOpen((value) => !value)}
                    >
                      <ExternalLinkIcon boxSize={3.5} />
                      新建 / 导入
                    </ProductButton>
                    <ProductMenu
                      open={importMenuOpen}
                      onClose={() => setImportMenuOpen(false)}
                      align="right"
                    >
                      <ProductMenuItem
                        icon={<AddIcon boxSize={3.5} />}
                        hint="创建一个目录整理 Source"
                        onClick={() => {
                          setImportMenuOpen(false);
                          openDirectory();
                        }}
                      >
                        文件夹
                      </ProductMenuItem>
                      <ProductMenuItem
                        icon={<AddIcon boxSize={3.5} />}
                        hint="上传文件、网页或自定义文本"
                        onClick={() => {
                          setImportMenuOpen(false);
                          setTextSourceDialogOpen(true);
                        }}
                      >
                        文本数据集
                      </ProductMenuItem>
                      <ProductMenuItem
                        icon={<AttachmentIcon boxSize={3.5} />}
                        hint="上传图片并建立图片知识"
                        onClick={() => {
                          setImportMenuOpen(false);
                          setImageDatasetOpen(true);
                        }}
                      >
                        图片数据集
                      </ProductMenuItem>
                      <ProductMenuItem
                        icon={<AddIcon boxSize={3.5} />}
                        hint="创建一个空的容器装入数据"
                        onClick={() => {
                          setImportMenuOpen(false);
                          setEmptyDatasetOpen(true);
                        }}
                      >
                        空白数据集
                      </ProductMenuItem>
                      <ProductMenuItem
                        icon={<CopyIcon boxSize={3.5} />}
                        hint="导入 CSV / XLSX 模版数据"
                        onClick={() => {
                          setImportMenuOpen(false);
                          setStructuredImportKind('template');
                        }}
                      >
                        模版导入
                      </ProductMenuItem>
                      <ProductMenuItem
                        icon={<DownloadIcon boxSize={3.5} />}
                        hint="恢复导出的知识库 CSV / XLSX"
                        onClick={() => {
                          setImportMenuOpen(false);
                          setStructuredImportKind('backup');
                        }}
                      >
                        备份导入
                      </ProductMenuItem>
                    </ProductMenu>
                  </div>
                </div>
              </div>

              <div className="kb2-toolbar kb2-collection-toolbar">
                <div className="kb2-toolbar__summary">
                  {search || tagId
                    ? `筛选结果 ${currentDirectories.length + currentSources.length} 项`
                    : '目录优先排序'}
                </div>
                <div className="kb2-toolbar__controls">
                  <ProductSearchBox
                    value={search}
                    onChange={setSearch}
                    placeholder="搜索文件或目录"
                  />
                  <ProductSelect
                    aria-label="标签筛选"
                    value={tagId}
                    onChange={(event) => {
                      setTagId(event.target.value);
                      setTagValue('');
                    }}
                  >
                    <option value="">全部标签</option>
                    {tags
                      .filter((tag) => tag.status === 'active')
                      .map((tag) => (
                        <option key={tag.id} value={tag.id}>
                          {tag.label}
                        </option>
                      ))}
                  </ProductSelect>
                  {selectedTag?.options?.length ? (
                    <ProductSelect
                      aria-label="标签值筛选"
                      value={tagValue}
                      onChange={(event) => setTagValue(event.target.value)}
                    >
                      <option value="">全部值</option>
                      {selectedTag.options.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </ProductSelect>
                  ) : null}
                  <ProductButton
                    size="sm"
                    tone={batchMode ? 'primary' : 'secondary'}
                    onClick={() => {
                      setBatchMode((value) => !value);
                      setSelectedSourceIds([]);
                      setArchiveStage('idle');
                    }}
                  >
                    <CheckIcon boxSize={3.5} />
                    批量管理
                  </ProductButton>
                </div>
              </div>

              {loading ? (
                <ProductSkeleton rows={3} />
              ) : currentDirectories.length === 0 && currentSources.length === 0 ? (
                <ProductEmpty
                  title={search || tagId ? '没有匹配的文件' : '这个知识库还没有数据'}
                  description={
                    search || tagId
                      ? '尝试清空搜索或标签筛选。'
                      : '通过“新建 / 导入”添加文件、网页、文本或其他知识来源。'
                  }
                  action={
                    search || tagId ? (
                      <ProductButton
                        onClick={() => {
                          setSearch('');
                          setTagId('');
                          setTagValue('');
                        }}
                      >
                        清空筛选
                      </ProductButton>
                    ) : null
                  }
                />
              ) : (
                <div className="kb2-collection-table-wrap">
                  <table className="kb2-collection-table">
                    <thead>
                      <tr>
                        <th className="kb2-collection-table__check">
                          <ProductCheckbox
                            checked={allVisibleSourcesSelected}
                            onChange={(checked) =>
                              setSelectedSourceIds(
                                checked ? currentSources.map((source) => source.id) : [],
                              )
                            }
                            label="选择当前页全部文件"
                            disabled={currentSources.length === 0}
                          />
                        </th>
                        <th>名称</th>
                        <th>处理模式</th>
                        <th>数据量</th>
                        <th>创建/更新时间</th>
                        <th>状态</th>
                        <th>启用</th>
                        <th aria-label="操作">
                          <span className="kb2-sr-only">操作</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {currentDirectories.map((directory) => {
                        const canWrite = permissionRank(directory.effectivePermission) >= 20;
                        const canManage = permissionRank(directory.effectivePermission) >= 30;
                        const canOwn = permissionRank(directory.effectivePermission) >= 40;
                        return (
                          <tr key={directory.id} className="kb2-directory-row">
                            <td className="kb2-collection-table__check" />
                            <td>
                              <button
                                type="button"
                                className="kb2-collection-name kb2-reset-button"
                                onClick={() =>
                                  navigate({
                                    datasetId,
                                    currentTab: 'collectionCard',
                                    parentId: directory.id,
                                  })
                                }
                              >
                                <ProductTypeIcon kind="folder" />
                                <span>
                                  <strong>{directory.name}</strong>
                                  <small>目录 · 深度 {directory.depth}</small>
                                </span>
                              </button>
                            </td>
                            <td>—</td>
                            <td>—</td>
                            <td>—</td>
                            <td>—</td>
                            <td>—</td>
                            <td>
                              {canWrite ? (
                                <div className="kb2-row-actions">
                                  <ProductIconButton
                                    label={`${directory.name} 的目录操作`}
                                    onClick={() =>
                                      setRowMenuId(rowMenuId === directory.id ? null : directory.id)
                                    }
                                  >
                                    <span className="kb2-more-dots">···</span>
                                  </ProductIconButton>
                                  <ProductMenu
                                    open={rowMenuId === directory.id}
                                    onClose={() => setRowMenuId(null)}
                                  >
                                    {canWrite ? (
                                      <ProductMenuItem
                                        icon={<EditIcon boxSize={3.5} />}
                                        onClick={() => {
                                          setRowMenuId(null);
                                          openDirectory(directory);
                                        }}
                                      >
                                        编辑目录
                                      </ProductMenuItem>
                                    ) : null}
                                    {canWrite ? (
                                      <ProductMenuItem
                                        icon={<CopyIcon boxSize={3.5} />}
                                        onClick={() => {
                                          setRowMenuId(null);
                                          openMoveDirectory(directory);
                                        }}
                                      >
                                        移动
                                      </ProductMenuItem>
                                    ) : null}
                                    {canManage ? (
                                      <ProductMenuItem
                                        icon={<LockIcon boxSize={3.5} />}
                                        onClick={() => {
                                          setRowMenuId(null);
                                          setPermissionTarget({
                                            kind: 'directory',
                                            id: directory.id,
                                            name: directory.name,
                                            version: directory.version,
                                          });
                                        }}
                                      >
                                        权限
                                      </ProductMenuItem>
                                    ) : null}
                                    {canOwn ? (
                                      <ProductMenuItem
                                        icon={<DeleteIcon boxSize={3.5} />}
                                        danger
                                        onClick={() => {
                                          setRowMenuId(null);
                                          setDeleteDirectoryTarget(directory);
                                          setDeleteError(null);
                                        }}
                                      >
                                        删除目录
                                      </ProductMenuItem>
                                    ) : null}
                                  </ProductMenu>
                                </div>
                              ) : null}
                            </td>
                          </tr>
                        );
                      })}
                      {currentSources.map((source) => {
                        const status = sourceStatusView(source.processingStatus);
                        const canRead = permissionRank(source.effectivePermission) >= 10;
                        const canWrite = permissionRank(source.effectivePermission) >= 20;
                        const canManage = permissionRank(source.effectivePermission) >= 30;
                        const canOwn = permissionRank(source.effectivePermission) >= 40;
                        return (
                          <tr key={source.id}>
                            <td className="kb2-collection-table__check">
                              {batchMode ? (
                                <ProductCheckbox
                                  checked={selectedSourceIds.includes(source.id)}
                                  onChange={(checked) =>
                                    setSelectedSourceIds((current) =>
                                      checked
                                        ? [...new Set([...current, source.id])]
                                        : current.filter((id) => id !== source.id),
                                    )
                                  }
                                  label={`选择 ${source.name}`}
                                />
                              ) : null}
                            </td>
                            <td>
                              <button
                                type="button"
                                className="kb2-collection-name kb2-reset-button"
                                onClick={() =>
                                  navigate({
                                    datasetId,
                                    currentTab: 'dataCard',
                                    collectionId: source.id,
                                    ...(currentDirectoryId ? { parentId: currentDirectoryId } : {}),
                                  })
                                }
                              >
                                <ProductTypeIcon kind={productTypeOf(source.kind).kind} />
                                <span>
                                  <strong title={source.name}>{source.name}</strong>
                                </span>
                              </button>
                            </td>
                            <td>{processingModelLabel(source.processingModel)}</td>
                            <td>{source.segmentCount ?? 0}</td>
                            <td className="kb2-collection-time">
                              <span>{formatSourceTime(source.createdAt)}</span>
                              <small>{formatSourceTime(source.updatedAt)}</small>
                            </td>
                            <td>
                              {canOpenTrainingState(source) ? (
                                <button
                                  type="button"
                                  className="kb2-status-button"
                                  onClick={() => setTrainingSource(source)}
                                  aria-label={`查看 ${source.name} 的训练状态：${status.label}`}
                                >
                                  <StatusTag value={status.label} tone={status.tone} dot />
                                </button>
                              ) : (
                                <StatusTag value={status.label} tone={status.tone} dot />
                              )}
                            </td>
                            <td>
                              <label className="kb2-switch">
                                <input
                                  type="checkbox"
                                  checked={source.searchEnabled}
                                  disabled={sourceToggleBusyId === source.id || !canWrite}
                                  onChange={(event) =>
                                    void toggleSource(source, event.target.checked)
                                  }
                                  aria-label={`${source.name} 启用搜索`}
                                />
                                <span />
                              </label>
                            </td>
                            <td>
                              <div className="kb2-row-actions">
                                {canRead ? (
                                  <ProductButton
                                    size="sm"
                                    tone="ghost"
                                    aria-label={`预览 ${source.name}`}
                                    onClick={(event) => {
                                      setPreviewTriggerElement(event.currentTarget);
                                      setPreviewSourceTarget(source);
                                      setPreviewRequest((value) => value + 1);
                                    }}
                                  >
                                    预览
                                  </ProductButton>
                                ) : null}
                                {canWrite ? (
                                  <>
                                    <ProductIconButton
                                      label={`${source.name} 的更多操作`}
                                      aria-expanded={rowMenuId === source.id}
                                      onClick={(event) => {
                                        setRowMenuInitialFocus(null);
                                        setRowMenuTriggerElement(event.currentTarget);
                                        setRowMenuId(rowMenuId === source.id ? null : source.id);
                                      }}
                                      onKeyDown={(event) => {
                                        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
                                          return;
                                        }
                                        event.preventDefault();
                                        setRowMenuTriggerElement(event.currentTarget);
                                        setRowMenuInitialFocus(
                                          event.key === 'ArrowDown' ? 'first' : 'last',
                                        );
                                        setRowMenuId(source.id);
                                      }}
                                    >
                                      <span className="kb2-more-dots">···</span>
                                    </ProductIconButton>
                                    <ProductMenu
                                      open={rowMenuId === source.id}
                                      triggerElement={rowMenuTriggerElement}
                                      initialFocus={rowMenuInitialFocus ?? undefined}
                                      onClose={() => {
                                        setRowMenuId(null);
                                        setRowMenuTriggerElement(null);
                                        setRowMenuInitialFocus(null);
                                      }}
                                    >
                                      {source.connectorId ? (
                                        <ProductMenuItem
                                          icon={<RepeatIcon boxSize={3.5} />}
                                          disabled={sourceSyncBusyId === source.id}
                                          onClick={() => void syncSource(source)}
                                        >
                                          同步
                                        </ProductMenuItem>
                                      ) : null}
                                      <ProductMenuItem
                                        icon={<CopyIcon boxSize={3.5} />}
                                        onClick={() => openMoveSource(source)}
                                      >
                                        移动
                                      </ProductMenuItem>
                                      <ProductMenuItem
                                        icon={<EditIcon boxSize={3.5} />}
                                        onClick={() => openRenameSource(source)}
                                      >
                                        重命名
                                      </ProductMenuItem>
                                      {canManage ? (
                                        <ProductMenuItem
                                          icon={<LockIcon boxSize={3.5} />}
                                          onClick={() => {
                                            setRowMenuId(null);
                                            setPermissionTarget({
                                              kind: 'source',
                                              id: source.id,
                                              name: source.name,
                                              version: source.version,
                                              source,
                                            });
                                          }}
                                        >
                                          权限
                                        </ProductMenuItem>
                                      ) : null}
                                      <ProductMenuItem
                                        icon={<AttachmentIcon boxSize={3.5} />}
                                        onClick={() => {
                                          setRowMenuId(null);
                                          openTagAssignment(source);
                                        }}
                                      >
                                        标签设置
                                      </ProductMenuItem>
                                      {canOwn ? (
                                        <ProductMenuItem
                                          icon={<DeleteIcon boxSize={3.5} />}
                                          danger
                                          onClick={() => {
                                            setRowMenuId(null);
                                            setDeleteSourceTarget(source);
                                            setDeleteError(null);
                                          }}
                                        >
                                          删除
                                        </ProductMenuItem>
                                      ) : null}
                                    </ProductMenu>
                                  </>
                                ) : null}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            {currentDirectory ? (
              <DirectoryInfoPanel
                directory={currentDirectory}
                onEdit={() => openDirectory(currentDirectory)}
                onMove={() => openMoveDirectory(currentDirectory)}
                onPermission={() =>
                  setPermissionTarget({
                    kind: 'directory',
                    id: currentDirectory.id,
                    name: currentDirectory.name,
                    version: currentDirectory.version,
                  })
                }
                onDelete={() => {
                  setDeleteDirectoryTarget(currentDirectory);
                  setDeleteError(null);
                }}
              />
            ) : (
              <DatasetInfoPanel
                space={space}
                bindings={bindings}
                models={models}
                modelsError={modelsQuery.error}
                modelsLoading={modelsQuery.isLoading}
                onRetryModels={() => void modelsQuery.refetch()}
                rebuilding={jobs.some(
                  (job) =>
                    job.knowledgeSpaceId === datasetId &&
                    job.kind === 'rebuild' &&
                    !['succeeded', 'failed', 'cancelled', 'dead_letter'].includes(job.status),
                )}
                onEdit={openEditDataset}
                onPermission={() =>
                  space &&
                  setPermissionTarget({
                    kind: 'space',
                    id: space.id,
                    name: space.name,
                    version: space.version,
                  })
                }
                onChanged={() => void invalidateCollection()}
              />
            )}
          </div>
        )}

        {batchMode && selectedSourceIds.length > 0 ? (
          <div className="kb2-batch-bar" role="region" aria-label="Collection 批量操作">
            <span className="kb2-batch-bar__count">已选择 {selectedSourceIds.length} 个文件</span>
            {archiveStage !== 'idle' ? (
              <span role="status" className="kb2-batch-bar__count">
                {archiveStage === 'queued'
                  ? '打包任务已排队'
                  : archiveStage === 'running'
                    ? '正在生成压缩包'
                    : '压缩包已开始下载'}
              </span>
            ) : null}
            <ProductButton busy={batchBusy} onClick={() => void archiveSelected()}>
              <DownloadIcon boxSize={3.5} />
              批量下载
            </ProductButton>
            <ProductButton
              disabled={tags.length === 0}
              onClick={() => {
                setBatchTagId('');
                setBatchTagValue('');
                setBatchError(null);
                setBatchDialog('tag');
              }}
            >
              批量修改标签
            </ProductButton>
            <ProductButton
              tone="danger"
              onClick={() => {
                setBatchDeleteText('');
                setBatchError(null);
                setBatchDialog('delete');
              }}
            >
              批量删除
            </ProductButton>
            <ProductButton tone="ghost" onClick={() => setSelectedSourceIds([])}>
              清空选择
            </ProductButton>
          </div>
        ) : null}
        {batchResult ? (
          <div className="kb2-note" role="status">
            批量操作结果：成功 {batchResult.succeeded} 项，失败 {batchResult.failed} 项。
          </div>
        ) : null}
      </ProductPage>

      <TextSourceDialog
        open={textSourceDialogOpen}
        onClose={() => setTextSourceDialogOpen(false)}
        onChoose={(source: TextImportSource) =>
          navigate({
            datasetId,
            currentTab: 'import',
            ...(currentDirectoryId ? { parentId: currentDirectoryId } : {}),
            source,
          })
        }
      />

      <EmptySourceDialog
        open={emptyDatasetOpen}
        spaceId={datasetId}
        directoryId={currentDirectoryId}
        onClose={() => setEmptyDatasetOpen(false)}
        onCompleted={() => void invalidateCollection()}
      />

      <ImageDatasetDialog
        open={imageDatasetOpen}
        spaceId={datasetId}
        directoryId={currentDirectoryId}
        onClose={() => setImageDatasetOpen(false)}
        onCompleted={() => void invalidateCollection()}
      />

      {structuredImportKind ? (
        <StructuredImportDialog
          open
          kind={structuredImportKind}
          spaceId={datasetId}
          directoryId={currentDirectoryId}
          onClose={() => setStructuredImportKind(null)}
          onCompleted={() => void invalidateCollection()}
        />
      ) : null}

      <ProductModal
        open={Boolean(directoryForm)}
        title={directoryForm?.mode === 'edit' ? '编辑目录' : '新建目录'}
        onClose={() => !directoryBusy && setDirectoryForm(null)}
        footer={
          <>
            <ProductButton onClick={() => setDirectoryForm(null)} disabled={directoryBusy}>
              取消
            </ProductButton>
            <ProductButton
              tone="primary"
              busy={directoryBusy}
              onClick={() =>
                (
                  document.getElementById('kb2-directory-form') as HTMLFormElement | null
                )?.requestSubmit()
              }
            >
              保存
            </ProductButton>
          </>
        }
      >
        <form id="kb2-directory-form" onSubmit={submitDirectory}>
          <ProductField label="目录名称">
            <ProductInput
              value={directoryName}
              onChange={(event) => setDirectoryName(event.target.value)}
              maxLength={120}
              autoFocus
            />
          </ProductField>
          <ProductError error={directoryError} />
        </form>
      </ProductModal>

      <ProductModal
        open={Boolean(deleteDirectoryTarget)}
        title="删除目录"
        description="目录及其中内容可能被永久删除。"
        onClose={() => !deleteBusy && setDeleteDirectoryTarget(null)}
        footer={
          <>
            <ProductButton onClick={() => setDeleteDirectoryTarget(null)} disabled={deleteBusy}>
              取消
            </ProductButton>
            <ProductButton tone="danger" busy={deleteBusy} onClick={() => void removeDirectory()}>
              确认删除
            </ProductButton>
          </>
        }
      >
        <p className="kb2-confirm-copy">
          确认删除目录 <strong>{deleteDirectoryTarget?.name}</strong>？
        </p>
        <ProductError error={deleteError} />
      </ProductModal>

      <ProductModal
        open={Boolean(deleteSourceTarget)}
        title="删除文件"
        description="删除后关联数据块可能同时删除。"
        onClose={() => !deleteBusy && setDeleteSourceTarget(null)}
        footer={
          <>
            <ProductButton onClick={() => setDeleteSourceTarget(null)} disabled={deleteBusy}>
              取消
            </ProductButton>
            <ProductButton tone="danger" busy={deleteBusy} onClick={() => void removeSource()}>
              确认删除
            </ProductButton>
          </>
        }
      >
        <p className="kb2-confirm-copy">
          确认删除 <strong>{deleteSourceTarget?.name}</strong>？
        </p>
        <ProductError error={deleteError} />
      </ProductModal>

      <ProductModal
        open={Boolean(moveSourceTarget)}
        title="移动文件"
        onClose={() => !moveBusy && setMoveSourceTarget(null)}
        footer={
          <>
            <ProductButton onClick={() => setMoveSourceTarget(null)} disabled={moveBusy}>
              取消
            </ProductButton>
            <ProductButton
              tone="primary"
              busy={moveBusy}
              onClick={() =>
                (
                  document.getElementById('kb2-source-move-form') as HTMLFormElement | null
                )?.requestSubmit()
              }
            >
              移动
            </ProductButton>
          </>
        }
      >
        <form id="kb2-source-move-form" onSubmit={submitSourceMove}>
          <ProductField label="目标目录">
            <ProductSelect
              value={moveTargetId}
              onChange={(event) => setMoveTargetId(event.target.value)}
            >
              <option value="">知识库根目录</option>
              {directories.map((directory) => (
                <option key={directory.id} value={directory.id}>
                  {directory.name}
                </option>
              ))}
            </ProductSelect>
          </ProductField>
          <ProductError error={moveError} />
        </form>
      </ProductModal>

      <ProductModal
        open={Boolean(moveDirectoryTarget)}
        title="移动目录"
        onClose={() => !moveBusy && setMoveDirectoryTarget(null)}
        footer={
          <>
            <ProductButton onClick={() => setMoveDirectoryTarget(null)} disabled={moveBusy}>
              取消
            </ProductButton>
            <ProductButton
              tone="primary"
              busy={moveBusy}
              onClick={() =>
                (
                  document.getElementById('kb2-directory-move-form') as HTMLFormElement | null
                )?.requestSubmit()
              }
            >
              移动
            </ProductButton>
          </>
        }
      >
        <form id="kb2-directory-move-form" onSubmit={submitDirectoryMove}>
          <ProductField label="目标目录">
            <ProductSelect
              value={moveTargetId}
              onChange={(event) => setMoveTargetId(event.target.value)}
            >
              <option value="">知识库根目录</option>
              {directories
                .filter(
                  (directory) =>
                    moveDirectoryTarget &&
                    directory.id !== moveDirectoryTarget.id &&
                    !descendantDirectoryIds(directories, moveDirectoryTarget.id).has(directory.id),
                )
                .map((directory) => (
                  <option key={directory.id} value={directory.id}>
                    {directory.name}
                  </option>
                ))}
            </ProductSelect>
          </ProductField>
          <ProductError error={moveError} />
        </form>
      </ProductModal>

      <ProductModal
        open={batchDialog === 'tag'}
        title="批量修改标签"
        description={`应用到 ${selectedSources.length} 个文件`}
        onClose={() => !batchBusy && setBatchDialog(null)}
        footer={
          <>
            <ProductButton onClick={() => setBatchDialog(null)} disabled={batchBusy}>
              取消
            </ProductButton>
            <ProductButton
              tone="primary"
              busy={batchBusy}
              disabled={!batchTag}
              onClick={() => void applyBatchTag()}
            >
              保存
            </ProductButton>
          </>
        }
      >
        <TagValueEditor
          tags={tags}
          selectedTagId={batchTagId}
          value={batchTagValue}
          onTagChange={(value) => {
            setBatchTagId(value);
            setBatchTagValue('');
          }}
          onValueChange={setBatchTagValue}
          tag={batchTag}
        />
        <ProductError error={batchError} />
      </ProductModal>

      <ProductModal
        open={batchDialog === 'delete'}
        title="批量删除文件"
        description={`将删除 ${selectedSources.length} 个文件`}
        onClose={() => !batchBusy && setBatchDialog(null)}
        footer={
          <>
            <ProductButton onClick={() => setBatchDialog(null)} disabled={batchBusy}>
              取消
            </ProductButton>
            <ProductButton
              tone="danger"
              busy={batchBusy}
              disabled={batchDeleteText !== batchDeleteConfirmation}
              onClick={() => void deleteBatch()}
            >
              确认删除
            </ProductButton>
          </>
        }
      >
        <p className="kb2-confirm-copy">
          请输入 <strong>{batchDeleteConfirmation}</strong> 以确认。
        </p>
        <ProductField label="确认文本">
          <ProductInput
            value={batchDeleteText}
            onChange={(event) => setBatchDeleteText(event.target.value)}
          />
        </ProductField>
        <ProductError error={batchError} />
      </ProductModal>

      <TagManagerDialog
        open={tagManagerOpen}
        spaceId={datasetId}
        tags={tags}
        onClose={() => setTagManagerOpen(false)}
        onChanged={() => void invalidateCollection()}
      />

      <ProductModal
        open={Boolean(tagAssignmentTarget)}
        title="标签设置"
        description={tagAssignmentTarget?.name}
        size="xl"
        width="min(800px, calc(100vw - 24px))"
        onClose={() => !tagAssignmentBusy && setTagAssignmentTarget(null)}
        footer={
          <>
            <ProductButton
              onClick={() => setTagAssignmentTarget(null)}
              disabled={tagAssignmentBusy}
            >
              取消
            </ProductButton>
            <ProductButton
              tone="primary"
              busy={tagAssignmentBusy}
              disabled={
                tagAssignmentBusy ||
                tagAssignmentRows.length === 0 ||
                tagAssignmentRows.some(
                  (row) =>
                    !row.tagId || !row.value.trim() || !tags.some((tag) => tag.id === row.tagId),
                )
              }
              onClick={() => void assignSourceTag()}
            >
              保存
            </ProductButton>
          </>
        }
      >
        <div className="kb2-tag-table kb2-source-tag-table">
          <div className="kb2-tag-table__head" role="row">
            <span>标签名称</span>
            <span>标签值</span>
            <span>操作</span>
          </div>
          {tagAssignmentRows.length === 0 ? (
            <div className="kb2-tag-table__empty">当前没有标签，请先添加或打开标签管理。</div>
          ) : (
            tagAssignmentRows.map((row) => {
              const selectedTag = tags.find((tag) => tag.id === row.tagId);
              const usedByOtherRows = new Set(
                tagAssignmentRows
                  .filter((candidate) => candidate.id !== row.id)
                  .map((candidate) => candidate.tagId)
                  .filter(Boolean),
              );
              const inputType =
                selectedTag?.tagType === 'number'
                  ? 'number'
                  : selectedTag?.tagType === 'datetime'
                    ? 'datetime-local'
                    : 'text';
              return (
                <div className="kb2-tag-table__row" role="row" key={row.id}>
                  <span className="kb2-tag-table__name">
                    <ProductSelect
                      aria-label="标签名称"
                      value={row.tagId}
                      onChange={(event) => {
                        const tagId = event.target.value;
                        setTagAssignmentRows((current) =>
                          current.map((item) =>
                            item.id === row.id ? { ...item, tagId, value: '' } : item,
                          ),
                        );
                      }}
                    >
                      <option value="">请选择标签</option>
                      {tags
                        .filter((tag) => tag.status === 'active' && !usedByOtherRows.has(tag.id))
                        .map((tag) => (
                          <option key={tag.id} value={tag.id}>
                            {tag.label}
                          </option>
                        ))}
                    </ProductSelect>
                  </span>
                  <span className="kb2-tag-table__attribute">
                    <ProductInput
                      aria-label={`${selectedTag?.label ?? '标签'}值`}
                      type={inputType}
                      list={
                        selectedTag?.options?.length ? `tag-options-${selectedTag.id}` : undefined
                      }
                      value={row.value}
                      placeholder={
                        selectedTag?.tagType === 'array'
                          ? '选择或输入多个选项，使用逗号分隔'
                          : selectedTag?.tagType === 'number'
                            ? '输入数字'
                            : selectedTag?.tagType === 'datetime'
                              ? '选择日期时间'
                              : '输入标签值'
                      }
                      onChange={(event) => {
                        const value = event.target.value;
                        setTagAssignmentRows((current) =>
                          current.map((item) => (item.id === row.id ? { ...item, value } : item)),
                        );
                      }}
                    />
                    {selectedTag?.options?.length ? (
                      <datalist id={`tag-options-${selectedTag.id}`}>
                        {selectedTag.options.map((option) => (
                          <option value={option} key={option} />
                        ))}
                      </datalist>
                    ) : null}
                    {selectedTag ? (
                      <small>
                        {selectedTag.tagType === 'array'
                          ? '选项标签；不存在的值会在保存前加入标签选项'
                          : selectedTag.tagType === 'number'
                            ? '数字标签'
                            : selectedTag.tagType === 'datetime'
                              ? '日期标签'
                              : '文本标签'}
                      </small>
                    ) : null}
                  </span>
                  <span className="kb2-tag-table__actions">
                    <ProductIconButton
                      label={`删除 ${selectedTag?.label ?? '标签行'}`}
                      tone="danger"
                      onClick={() => {
                        setTagAssignmentRows((current) => {
                          const next = current.filter((item) => item.id !== row.id);
                          return next.length > 0
                            ? next
                            : [
                                {
                                  id: globalThis.crypto.randomUUID(),
                                  tagId: '',
                                  value: '',
                                  existing: false,
                                },
                              ];
                        });
                        if (row.existing && row.tagId) {
                          setRemovedTagIds((current) =>
                            current.includes(row.tagId) ? current : [...current, row.tagId],
                          );
                        }
                      }}
                    >
                      <DeleteIcon boxSize={3.5} />
                    </ProductIconButton>
                  </span>
                </div>
              );
            })
          )}
        </div>
        <div className="kb2-tag-assignment-actions">
          <ProductButton
            size="sm"
            disabled={
              tags.length === 0 ||
              tagAssignmentRows.length >= tags.length ||
              tagAssignmentRows.some((row) => !row.tagId || !row.value.trim())
            }
            onClick={() => {
              const used = new Set(tagAssignmentRows.map((row) => row.tagId));
              const next = tags.find((tag) => tag.status === 'active' && !used.has(tag.id));
              setTagAssignmentRows((current) => [
                ...current,
                {
                  id: globalThis.crypto.randomUUID(),
                  tagId: next?.id ?? '',
                  value: '',
                  existing: false,
                },
              ]);
            }}
          >
            <AddIcon boxSize={3.5} />
            添加标签
          </ProductButton>
          <ProductButton size="sm" onClick={() => setTagManagerOpen(true)}>
            标签管理
          </ProductButton>
        </div>
        {tagAssignmentTarget ? (
          <div className="kb2-note">
            当前标签：
            {tagValuesForSource(tagAssignmentTarget, tags)
              .map((tag) => `${tag.label}:${tag.value}`)
              .join('；') || '无'}
          </div>
        ) : null}
        <ProductError error={tagAssignmentError} />
      </ProductModal>

      <SourceRenameDialog
        source={renameSourceTarget}
        onClose={() => setRenameSourceTarget(null)}
        onChanged={() => void invalidateCollection()}
      />

      <ResourcePermissionDialog
        target={permissionTarget}
        space={space}
        onClose={() => setPermissionTarget(null)}
        onChanged={() => void invalidateCollection()}
      />

      <ProductModal
        open={editDatasetOpen}
        title="编辑知识库信息"
        onClose={() => !editDatasetBusy && setEditDatasetOpen(false)}
        footer={
          <>
            <ProductButton onClick={() => setEditDatasetOpen(false)} disabled={editDatasetBusy}>
              取消
            </ProductButton>
            <ProductButton
              tone="primary"
              busy={editDatasetBusy}
              onClick={() =>
                (
                  document.getElementById('kb2-dataset-edit-form') as HTMLFormElement | null
                )?.requestSubmit()
              }
            >
              保存
            </ProductButton>
          </>
        }
      >
        <form id="kb2-dataset-edit-form" className="kb2-form-grid" onSubmit={submitDatasetEdit}>
          <ProductField label="名称">
            <ProductInput
              value={editDatasetName}
              onChange={(event) => setEditDatasetName(event.target.value)}
              maxLength={120}
              autoFocus
            />
          </ProductField>
          <ProductField label="说明">
            <ProductInput
              value={editDatasetDescription}
              onChange={(event) => setEditDatasetDescription(event.target.value)}
              maxLength={2000}
            />
          </ProductField>
          <div className="kb2-form-grid__full">
            <ProductError error={editDatasetError} />
          </div>
        </form>
      </ProductModal>

      <SourcePreviewDialog
        source={previewSourceTarget}
        query={sourcePreviewQuery}
        finalFocusRef={{ current: previewTriggerElement }}
        onClose={() => setPreviewSourceTarget(null)}
        onRetry={() => setPreviewRequest((value) => value + 1)}
        onDownload={() => {
          if (previewSourceTarget) void downloadOne(previewSourceTarget);
        }}
      />

      <TrainingDialog
        source={trainingSource}
        job={trainingSource ? latestJobs.get(trainingSource.id) : undefined}
        jobs={jobs}
        isAdmin={space?.effectivePermission === 'owner' || space?.effectivePermission === 'manage'}
        onClose={() => setTrainingSource(null)}
        onRetried={() => void invalidateCollection()}
      />
      <TrainingErrorDialog
        open={trainingErrorOpen}
        sources={sources}
        jobs={failedJobs}
        onClose={() => setTrainingErrorOpen(false)}
        onRefresh={() => void invalidateCollection()}
        onOpenSource={(source) => {
          setTrainingErrorOpen(false);
          setTrainingSource(source);
        }}
      />
    </ProductAppShell>
  );
}

function SourcePreviewDialog(props: {
  source: Source | null;
  query: {
    data?: SourcePreviewView;
    error: unknown;
    isLoading: boolean;
  };
  finalFocusRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onRetry: () => void;
  onDownload: () => void;
}) {
  const [imageError, setImageError] = useState<unknown>(null);
  useEffect(() => setImageError(null), [props.query.data]);

  const emptyText =
    props.query.data?.kind === 'text' &&
    props.query.data.sections.every((section) => section.text.trim().length === 0);

  return (
    <ProductModal
      open={Boolean(props.source)}
      title="预览原始内容"
      description={props.source?.name}
      size="xl"
      finalFocusRef={props.finalFocusRef}
      onClose={props.onClose}
      footer={
        <ProductButton tone="secondary" onClick={props.onDownload}>
          <DownloadIcon boxSize={3.5} />
          下载原始文件
        </ProductButton>
      }
    >
      {props.query.isLoading ? <ProductSkeleton rows={4} /> : null}
      {!props.query.isLoading && props.query.error ? (
        <ProductError error={props.query.error} onRetry={props.onRetry} />
      ) : null}
      {!props.query.isLoading && props.query.data?.kind === 'image' ? (
        imageError ? (
          <div className="kb2-source-preview-error">
            <ProductError error={imageError} />
            <ProductButton
              size="sm"
              onClick={() => {
                setImageError(null);
                props.onRetry();
              }}
            >
              重新获取预览链接
            </ProductButton>
          </div>
        ) : (
          <img
            key={props.query.data.url}
            className="kb2-source-preview-image"
            src={props.query.data.url}
            alt={`${props.source?.name ?? 'Source'} 图片预览`}
            onError={() => setImageError(new Error('图片预览链接已失效，请重新获取。'))}
          />
        )
      ) : null}
      {!props.query.isLoading && emptyText ? (
        <ProductEmpty
          title="暂无可预览文本"
          description="该 Source 的原文为空，解析结果可能仍在生成。"
        />
      ) : null}
      {!props.query.isLoading && props.query.data?.kind === 'text' && !emptyText ? (
        <div className="kb2-source-preview">
          {props.query.data.sections.map((section, index) => (
            <article key={`${section.page ?? section.title ?? 'section'}-${index}`}>
              {section.title || section.page !== undefined ? (
                <h3>
                  {section.title}
                  {section.page !== undefined ? ` · 第 ${section.page + 1} 页` : ''}
                </h3>
              ) : null}
              <p>{section.text}</p>
            </article>
          ))}
        </div>
      ) : null}
    </ProductModal>
  );
}

function DatasetBreadcrumb(props: {
  datasetName: string;
  directoryPath: Directory[];
  onRoot: () => void;
  onDirectory: (directory: Directory) => void;
}) {
  return (
    <>
      <button type="button" onClick={() => window.location.assign('/dataset/list')}>
        我的知识库
      </button>
      <span className="kb2-breadcrumb-segment">
        <ChevronRightIcon boxSize={3} />
        <button type="button" onClick={props.onRoot}>
          {props.datasetName}
        </button>
      </span>
      {props.directoryPath.map((directory) => (
        <span key={directory.id} className="kb2-breadcrumb-segment">
          <ChevronRightIcon boxSize={3} />
          <button type="button" onClick={() => props.onDirectory(directory)}>
            {directory.name}
          </button>
        </span>
      ))}
    </>
  );
}

function DatasetInfoPanel(props: {
  space?: KnowledgeSpace;
  bindings: ModelBinding[];
  models: Model[];
  modelsError?: unknown;
  modelsLoading?: boolean;
  onRetryModels?: () => void;
  rebuilding: boolean;
  onEdit: () => void;
  onPermission: () => void;
  onChanged: () => void;
}) {
  const toast = useProductToast();
  const [modelsOpen, setModelsOpen] = useState(false);
  const [modelDraft, setModelDraft] = useState<Record<string, string>>({});
  const [modelsBusy, setModelsBusy] = useState(false);
  const [modelsError, setModelsError] = useState<unknown>(null);
  const [pendingModelBindings, setPendingModelBindings] = useState<ModelBinding[] | null>(null);
  const [modelConfirmCountdown, setModelConfirmCountdown] = useState(0);
  const [pendingAutoSync, setPendingAutoSync] = useState<boolean | null>(null);
  const [autoSyncBusy, setAutoSyncBusy] = useState(false);
  const [autoSyncError, setAutoSyncError] = useState<unknown>(null);
  const type = productTypeOf(props.space?.iconKey);
  const canManage = permissionRank(props.space?.effectivePermission) >= 30;
  const binding = (modelType: ModelBinding['modelType']) =>
    props.bindings.find((entry) => entry.modelType === modelType && entry.status === 'active');
  const authorizedModels = (role: KnowledgeModelRole) => modelsForRole(props.models, role);
  const modelsUnavailable =
    Boolean(props.modelsError) || (!props.modelsLoading && props.models.length === 0);

  useEffect(() => {
    if (!pendingModelBindings || modelConfirmCountdown <= 0) return;
    const timer = window.setTimeout(
      () => setModelConfirmCountdown((current) => Math.max(0, current - 1)),
      1_000,
    );
    return () => window.clearTimeout(timer);
  }, [modelConfirmCountdown, pendingModelBindings]);

  const persistModels = async (next: ModelBinding[]) => {
    if (!props.space) return false;
    setModelsBusy(true);
    setModelsError(null);
    try {
      await updateModelBindings(props.space.id, next, props.space.version);
      props.onChanged();
      setModelsOpen(false);
      setPendingModelBindings(null);
      toast.success('模型配置已更新');
      return true;
    } catch (caught) {
      setModelsError(caught);
      return false;
    } finally {
      setModelsBusy(false);
    }
  };

  const changeModel = async (modelType: ModelBinding['modelType'], modelId: string) => {
    if (!props.space || modelsBusy || props.rebuilding || !canManage) return;
    const role =
      modelType === 'embedding' || modelType === 'llm' || modelType === 'vlm' ? modelType : null;
    if (!role) return;
    const selected = modelsForRole(props.models, role).find((item) => item.modelId === modelId);
    if (modelId && !selected) return;
    const next = props.bindings
      .filter((entry) => entry.modelType !== modelType && entry.status === 'active')
      .concat(
        selected
          ? [
              {
                modelType,
                modelId: selected.modelId,
                displayName: selected.displayName,
                requiredCapabilities: selected.capabilities,
                status: 'active' as const,
              },
            ]
          : [],
      );
    const currentEmbeddingModelId = binding('embedding')?.modelId ?? '';
    if (
      modelType === 'embedding' &&
      currentEmbeddingModelId &&
      currentEmbeddingModelId !== modelId
    ) {
      setModelsError(null);
      setModelConfirmCountdown(MODEL_REBUILD_CONFIRM_SECONDS);
      setPendingModelBindings(next);
      return;
    }
    await persistModels(next);
  };

  const saveModels = async () => {
    if (!props.space) return;
    const next = (['llm', 'embedding', 'vlm'] as const).flatMap((modelType) => {
      const model = modelsForRole(props.models, modelType).find(
        (item) => item.modelId === modelDraft[modelType],
      );
      if (!model) return [];
      return [
        {
          modelType,
          modelId: model.modelId,
          displayName: model.displayName,
          requiredCapabilities: model.capabilities,
          status: 'active' as const,
        },
      ];
    });
    const currentEmbeddingModelId = binding('embedding')?.modelId ?? '';
    if (currentEmbeddingModelId && currentEmbeddingModelId !== modelDraft.embedding) {
      setModelsError(null);
      setModelsOpen(false);
      setModelConfirmCountdown(MODEL_REBUILD_CONFIRM_SECONDS);
      setPendingModelBindings(next);
      return;
    }
    await persistModels(next);
  };

  const cancelModelRebuild = () => {
    if (modelsBusy) return;
    setPendingModelBindings(null);
    setModelConfirmCountdown(0);
    setModelsError(null);
  };

  const saveAutoSync = async () => {
    if (!props.space || pendingAutoSync === null) return;
    setAutoSyncBusy(true);
    setAutoSyncError(null);
    try {
      await updateSpace(props.space.id, {
        version: props.space.version,
        autoSync: pendingAutoSync,
      });
      props.onChanged();
      setPendingAutoSync(null);
      toast.success(pendingAutoSync ? '定时同步已开启' : '定时同步已关闭');
    } catch (caught) {
      setAutoSyncError(caught);
    } finally {
      setAutoSyncBusy(false);
    }
  };

  return (
    <>
      <aside className="kb2-info-panel" aria-label="知识库信息">
        <div className="kb2-info-panel__headline">
          <ProductTypeIcon kind={type.kind} />
          <div>
            <h2 title={props.space?.name}>{props.space?.name ?? '加载中'}</h2>
            <StatusTag value={type.label} tone="info" />
          </div>
          <ProductIconButton label="编辑知识库信息" onClick={props.onEdit}>
            <EditIcon boxSize={3.5} />
          </ProductIconButton>
        </div>
        <p>{props.space?.description || '这个知识库还没有介绍。'}</p>
        <div className="kb2-info-group">
          <h3>基本信息</h3>
          <InfoLine label="知识库 ID" value={props.space?.id ?? '—'} mono />
          <InfoLine label="创建者" value={props.space?.ownershipMemberId ?? '后端未提供'} />
          <InfoLine
            label="访问模式"
            value={props.space?.accessMode === 'restricted' ? '受限访问' : '工作区可见'}
          />
          <InfoLine label="更新时间" value={formatDate(props.space?.updatedAt)} />
        </div>
        <div className="kb2-info-group">
          <div className="kb2-info-group__title">
            <h3>模型配置</h3>
          </div>
          <div className="kb2-model-select-row">
            <span>索引模型</span>
            <ModelSelect
              label="索引模型"
              models={authorizedModels('embedding')}
              value={binding('embedding')?.modelId ?? ''}
              onChange={(modelId) => void changeModel('embedding', modelId)}
              unsetLabel="未设置"
              disabled={modelsBusy || props.rebuilding || !canManage || modelsUnavailable}
            />
          </div>
          <div className="kb2-model-select-row">
            <span>文本理解模型</span>
            <ModelSelect
              label="文本理解模型"
              models={authorizedModels('llm')}
              value={binding('llm')?.modelId ?? ''}
              onChange={(modelId) => void changeModel('llm', modelId)}
              unsetLabel="未设置"
              twoColumn
              disabled={modelsBusy || props.rebuilding || !canManage || modelsUnavailable}
            />
          </div>
          <div className="kb2-model-select-row">
            <span>图片理解模型</span>
            <ModelSelect
              label="图片理解模型"
              models={authorizedModels('vlm')}
              value={binding('vlm')?.modelId ?? ''}
              onChange={(modelId) => void changeModel('vlm', modelId)}
              unsetLabel="不设置"
              twoColumn
              disabled={modelsBusy || props.rebuilding || !canManage || modelsUnavailable}
            />
          </div>
          {!props.modelsLoading &&
          (['embedding', 'llm', 'vlm'] as const).some((role) => {
            const modelId = binding(role)?.modelId;
            return Boolean(
              modelId && !authorizedModels(role).some((model) => model.modelId === modelId),
            );
          }) ? (
            <div className="kb2-error-panel" role="alert">
              <WarningIcon boxSize={4} />
              <div>
                <strong>当前绑定模型不可用</strong>
                <span>请选择真实模型目录中的替代模型；修改索引模型后将重建索引。</span>
              </div>
            </div>
          ) : null}
          <ProductError error={modelsError} />
          {props.models.length === 0 ? (
            <div className="kb2-table-muted">模型目录暂不可用</div>
          ) : null}
          {props.rebuilding ? (
            <div className="kb2-table-muted">索引重建进行中，完成前不能再次修改模型。</div>
          ) : null}
        </div>
        <div className="kb2-info-group">
          <div className="kb2-info-group__title">
            <h3>定时同步</h3>
            <span title="开启后，知识库内支持同步的数据源会按连接器配置自动同步。">?</span>
          </div>
          <label className="kb2-model-select-row">
            <span>自动同步</span>
            <input
              type="checkbox"
              role="switch"
              aria-label="定时同步"
              checked={Boolean(props.space?.autoSync)}
              disabled={!canManage || autoSyncBusy}
              onChange={(event) => {
                setAutoSyncError(null);
                setPendingAutoSync(event.target.checked);
              }}
            />
          </label>
          <div className="kb2-table-muted">
            开启后，同步型数据源会按既定周期更新；手动同步仍可在来源操作菜单中执行。
          </div>
          <ProductError error={autoSyncError} />
        </div>
        {canManage ? (
          <div className="kb2-info-group">
            <div className="kb2-info-group__title">
              <h3>协作者</h3>
              <ProductIconButton label="管理协作者" onClick={props.onPermission}>
                <EditIcon boxSize={3.5} />
              </ProductIconButton>
            </div>
            <div className="kb2-collaborator-summary">
              <span className="kb2-collaborator-summary__avatar">创</span>
              <div>
                <strong>知识库创建者</strong>
                <small>知识库创建者与已授权成员</small>
              </div>
            </div>
          </div>
        ) : null}
      </aside>

      <ProductModal
        open={modelsOpen}
        title="模型配置"
        description="模型能力由真实模型目录提供。修改索引模型将触发服务端重建流程。"
        onClose={() => !modelsBusy && setModelsOpen(false)}
        footer={
          <>
            <ProductButton onClick={() => setModelsOpen(false)} disabled={modelsBusy}>
              取消
            </ProductButton>
            <ProductButton
              tone="primary"
              busy={modelsBusy}
              disabled={modelsBusy || props.modelsLoading || modelsUnavailable}
              onClick={() => void saveModels()}
            >
              保存
            </ProductButton>
          </>
        }
      >
        {props.modelsLoading ? (
          <div className="kb2-table-muted" role="status">
            正在加载模型目录…
          </div>
        ) : null}
        <ProductError error={props.modelsError} onRetry={props.onRetryModels} />
        {!props.modelsLoading && !props.modelsError && props.models.length === 0 ? (
          <div className="kb2-table-muted" role="status">
            模型目录为空，无法保存模型配置。
          </div>
        ) : null}
        <div className="kb2-form-grid">
          <ProductField label="索引模型">
            <ModelSelect
              label="索引模型"
              models={authorizedModels('embedding')}
              value={modelDraft.embedding ?? ''}
              onChange={(modelId) =>
                setModelDraft((current) => ({ ...current, embedding: modelId }))
              }
              unsetLabel="未设置"
            />
          </ProductField>
          <ProductField label="文本理解模型">
            <ModelSelect
              label="文本理解模型"
              models={authorizedModels('llm')}
              value={modelDraft.llm ?? ''}
              onChange={(modelId) => setModelDraft((current) => ({ ...current, llm: modelId }))}
              unsetLabel="未设置"
              twoColumn
            />
          </ProductField>
          <ProductField label="图片理解模型">
            <ModelSelect
              label="图片理解模型"
              models={authorizedModels('vlm')}
              value={modelDraft.vlm ?? ''}
              onChange={(modelId) => setModelDraft((current) => ({ ...current, vlm: modelId }))}
              unsetLabel="不设置"
              twoColumn
            />
          </ProductField>
        </div>
        <ProductError error={modelsError} />
      </ProductModal>

      <ProductModal
        open={Boolean(pendingModelBindings)}
        title="确认重建索引"
        description="切换索引模型需要重建全部向量索引和全文索引。"
        onClose={cancelModelRebuild}
        footer={
          <>
            <ProductButton onClick={cancelModelRebuild} disabled={modelsBusy}>
              取消
            </ProductButton>
            <ProductButton
              tone="danger"
              busy={modelsBusy}
              disabled={modelConfirmCountdown > 0}
              onClick={() => {
                if (pendingModelBindings && modelConfirmCountdown === 0) {
                  void persistModels(pendingModelBindings);
                }
              }}
            >
              确认重建（{modelConfirmCountdown}）
            </ProductButton>
          </>
        }
      >
        <p className="kb2-confirm-copy">
          将索引模型切换到“{modelDraft.embedding || '未设置'}
          ”。重建期间继续使用旧索引，完成后原子切换到新索引。
        </p>
        <p className="kb2-table-muted" aria-live="polite">
          为避免误操作，确认按钮将在 {modelConfirmCountdown} 秒后启用。
        </p>
        <ProductError error={modelsError} />
      </ProductModal>

      <ProductModal
        open={pendingAutoSync !== null}
        title={pendingAutoSync ? '开启定时同步' : '关闭定时同步'}
        onClose={() => !autoSyncBusy && setPendingAutoSync(null)}
        footer={
          <>
            <ProductButton onClick={() => setPendingAutoSync(null)} disabled={autoSyncBusy}>
              取消
            </ProductButton>
            <ProductButton
              tone="primary"
              busy={autoSyncBusy}
              disabled={autoSyncBusy}
              onClick={() => void saveAutoSync()}
            >
              确认
            </ProductButton>
          </>
        }
      >
        <p className="kb2-confirm-copy">
          {pendingAutoSync
            ? '开启后，知识库内支持同步的数据源会按连接器周期自动更新。'
            : '关闭后，所有自动同步计划将暂停；已有数据和连接器配置不会被删除。'}
        </p>
        <ProductError error={autoSyncError} />
      </ProductModal>
    </>
  );
}

function DirectoryInfoPanel(props: {
  directory: Directory;
  onEdit: () => void;
  onMove: () => void;
  onPermission: () => void;
  onDelete: () => void;
}) {
  const canWrite = permissionRank(props.directory.effectivePermission) >= 20;
  const canManage = permissionRank(props.directory.effectivePermission) >= 30;
  const canOwn = permissionRank(props.directory.effectivePermission) >= 40;
  return (
    <aside className="kb2-info-panel" aria-label="目录信息">
      <div className="kb2-info-panel__headline">
        <ProductTypeIcon kind="folder" />
        <div>
          <h2>{props.directory.name}</h2>
          <StatusTag value={`层级 ${props.directory.depth}`} tone="warning" />
        </div>
      </div>
      {canWrite ? (
        <div className="kb2-folder-panel__actions">
          <ProductButton size="sm" onClick={props.onEdit}>
            <EditIcon boxSize={3.5} />
            编辑
          </ProductButton>
          <ProductButton size="sm" onClick={props.onMove}>
            <CopyIcon boxSize={3.5} />
            移动
          </ProductButton>
          {canManage ? (
            <ProductButton size="sm" onClick={props.onPermission}>
              <LockIcon boxSize={3.5} />
              权限
            </ProductButton>
          ) : null}
          {canOwn ? (
            <ProductButton size="sm" tone="danger" onClick={props.onDelete}>
              <DeleteIcon boxSize={3.5} />
              删除
            </ProductButton>
          ) : null}
        </div>
      ) : null}
      <div className="kb2-info-group">
        <h3>目录信息</h3>
        <InfoLine label="目录 ID" value={props.directory.id} mono />
        <InfoLine label="权限模式" value={props.directory.aclMode} />
        <InfoLine label="版本" value={String(props.directory.version)} />
      </div>
    </aside>
  );
}

function InfoLine(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="kb2-info-line">
      <span>{props.label}</span>
      <strong className={props.mono ? 'kb2-inline-code' : undefined} title={props.value}>
        {props.value}
      </strong>
    </div>
  );
}

function TagValueEditor(props: {
  tags: Tag[];
  selectedTagId: string;
  value: string;
  tag?: Tag;
  onTagChange: (tagId: string) => void;
  onValueChange: (value: string) => void;
}) {
  return (
    <div className="kb2-form-grid">
      <ProductField label="标签">
        <ProductSelect
          value={props.selectedTagId}
          onChange={(event) => props.onTagChange(event.target.value)}
        >
          <option value="">请选择标签</option>
          {props.tags
            .filter((tag) => tag.status === 'active')
            .map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.label}
              </option>
            ))}
        </ProductSelect>
      </ProductField>
      <ProductField
        label="标签值"
        hint={props.tag?.tagType === 'array' ? '多个值使用英文逗号分隔' : undefined}
      >
        {props.tag?.options?.length ? (
          <ProductSelect
            value={props.value}
            onChange={(event) => props.onValueChange(event.target.value)}
          >
            <option value="">请选择值</option>
            {props.tag.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </ProductSelect>
        ) : (
          <ProductInput
            value={props.value}
            onChange={(event) => props.onValueChange(event.target.value)}
            placeholder={
              props.tag?.tagType === 'array'
                ? '例如：approved, internal'
                : props.tag?.tagType === 'number'
                  ? '输入数字'
                  : '输入标签值'
            }
            type={props.tag?.tagType === 'number' ? 'number' : 'text'}
          />
        )}
      </ProductField>
    </div>
  );
}

function parseTagInput(tag: Tag, raw: string): unknown {
  if (tag.tagType === 'number') return raw.trim() ? Number(raw) : null;
  if (tag.tagType === 'array') {
    const values = raw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    return values;
  }
  return raw.trim() || null;
}

function SourceRenameDialog(props: {
  source: Source | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useProductToast();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!props.source) return;
    setName(props.source.name);
    setError(null);
  }, [props.source]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!props.source || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await updateSource(props.source, { name: name.trim() });
      props.onChanged();
      props.onClose();
      toast.success('文件已重命名');
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ProductModal
      open={Boolean(props.source)}
      title="重命名文件"
      description={props.source?.name}
      onClose={() => !busy && props.onClose()}
      footer={
        <>
          <ProductButton onClick={props.onClose} disabled={busy}>
            取消
          </ProductButton>
          <ProductButton
            tone="primary"
            busy={busy}
            disabled={!name.trim()}
            onClick={() =>
              (
                document.getElementById('kb2-source-rename-form') as HTMLFormElement | null
              )?.requestSubmit()
            }
          >
            保存
          </ProductButton>
        </>
      }
    >
      <form id="kb2-source-rename-form" onSubmit={submit}>
        <ProductField label="文件名称">
          <ProductInput
            value={name}
            maxLength={240}
            autoFocus
            onChange={(event) => setName(event.target.value)}
          />
        </ProductField>
      </form>
      <ProductError error={error} />
    </ProductModal>
  );
}

function TagManagerDialog(props: {
  open: boolean;
  spaceId: string;
  tags: Tag[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useProductToast();
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newType, setNewType] = useState<Tag['tagType']>('array');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<Tag | null>(null);
  const [editingLabel, setEditingLabel] = useState('');
  const [optionsTag, setOptionsTag] = useState<Tag | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Tag | null>(null);

  useEffect(() => {
    if (!props.open) return;
    setAdding(false);
    setNewLabel('');
    setNewType('array');
    setEditing(null);
    setError(null);
    setOptionsTag(null);
    setDeleteTarget(null);
  }, [props.open]);

  const createKey = (label: string) => {
    const base = label
      .normalize('NFKD')
      .toLocaleLowerCase('en-US')
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48);
    const safeBase = /^[a-z].{0,47}$/.test(base) ? base : `tag_${base || 'field'}`;
    return `${safeBase}_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`.slice(
      0,
      64,
    );
  };

  const add = async () => {
    const label = newLabel.trim();
    if (!label) return;
    setBusy(true);
    setError(null);
    try {
      await createTag(props.spaceId, {
        key: createKey(label),
        label,
        tagType: newType,
        required: false,
        options: newType === 'array' ? [] : null,
      });
      props.onChanged();
      setNewLabel('');
      setNewType('array');
      setAdding(false);
      toast.success('标签已创建');
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const rename = async (tag: Tag) => {
    if (!editingLabel.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await updateTag(tag, { label: editingLabel.trim() });
      props.onChanged();
      setEditing(null);
      toast.success('标签已更新');
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (tag: Tag) => {
    setBusy(true);
    setError(null);
    try {
      await deleteTag(tag);
      props.onChanged();
      setDeleteTarget(null);
      toast.success('标签已删除');
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ProductModal
        open={props.open}
        title="标签管理"
        description="标签定义属于当前知识库，可应用到文件和批量操作。"
        size="lg"
        onClose={() => !busy && props.onClose()}
        footer={
          <ProductButton
            size="sm"
            onClick={() => {
              setEditing(null);
              setAdding(true);
              setNewLabel('');
              setNewType('array');
            }}
          >
            <AddIcon boxSize={3.5} />
            添加标签
          </ProductButton>
        }
      >
        <ProductError error={error} />
        <div className="kb2-tag-table-wrap">
          <div className="kb2-tag-table" role="table" aria-label="知识库标签">
            <div className="kb2-tag-table__head" role="row">
              <span role="columnheader">标签名称</span>
              <span role="columnheader">属性</span>
              <span role="columnheader">操作</span>
            </div>
            {props.tags.length === 0 && !adding ? (
              <div className="kb2-center-state">尚未定义标签</div>
            ) : null}
            {props.tags.map((tag) => {
              const typeLabel =
                tag.tagType === 'array'
                  ? '选项'
                  : tag.tagType === 'number'
                    ? '数字'
                    : tag.tagType === 'datetime'
                      ? '日期'
                      : '字符串';
              return (
                <div className="kb2-tag-table__row" role="row" key={tag.id}>
                  <div role="cell">
                    {editing?.id === tag.id ? (
                      <ProductInput
                        value={editingLabel}
                        maxLength={80}
                        aria-label="标签名称"
                        onChange={(event) => setEditingLabel(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') void rename(tag);
                          if (event.key === 'Escape') setEditing(null);
                        }}
                        autoFocus
                      />
                    ) : (
                      <span className="kb2-tag-table__name">{tag.label}</span>
                    )}
                  </div>
                  <div role="cell" className="kb2-tag-table__attribute">
                    <span>{typeLabel}</span>
                    {tag.required ? <small>必填</small> : null}
                    {tag.tagType === 'array' ? (
                      <ProductIconButton
                        label={`管理 ${tag.label} 的选项`}
                        onClick={() => setOptionsTag(tag)}
                      >
                        <EditIcon boxSize={3.5} />
                      </ProductIconButton>
                    ) : null}
                  </div>
                  <div role="cell" className="kb2-tag-table__actions">
                    {editing?.id === tag.id ? (
                      <>
                        <ProductIconButton
                          label="保存标签名称"
                          disabled={!editingLabel.trim()}
                          onClick={() => void rename(tag)}
                        >
                          <CheckIcon boxSize={3.5} />
                        </ProductIconButton>
                        <ProductIconButton label="取消编辑" onClick={() => setEditing(null)}>
                          <DeleteIcon boxSize={3.5} />
                        </ProductIconButton>
                      </>
                    ) : (
                      <>
                        <ProductIconButton
                          label={`编辑标签 ${tag.label}`}
                          onClick={() => {
                            setEditing(tag);
                            setEditingLabel(tag.label);
                          }}
                        >
                          <EditIcon boxSize={3.5} />
                        </ProductIconButton>
                        <ProductIconButton
                          label={`删除标签 ${tag.label}`}
                          tone="danger"
                          onClick={() => setDeleteTarget(tag)}
                        >
                          <DeleteIcon boxSize={3.5} />
                        </ProductIconButton>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
            {adding ? (
              <div className="kb2-tag-table__row is-new" role="row">
                <div role="cell">
                  <ProductInput
                    value={newLabel}
                    maxLength={80}
                    aria-label="新标签名称"
                    placeholder="请输入标签名称"
                    onChange={(event) => setNewLabel(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void add();
                      if (event.key === 'Escape') setAdding(false);
                    }}
                    autoFocus
                  />
                </div>
                <div role="cell">
                  <ProductSelect
                    aria-label="新标签属性"
                    value={newType}
                    onChange={(event) => setNewType(event.target.value as Tag['tagType'])}
                  >
                    <option value="array">选项</option>
                    <option value="number">数字</option>
                    <option value="datetime">日期</option>
                  </ProductSelect>
                </div>
                <div role="cell" className="kb2-tag-table__actions">
                  <ProductIconButton
                    label="保存新标签"
                    disabled={!newLabel.trim() || busy}
                    onClick={() => void add()}
                  >
                    <CheckIcon boxSize={3.5} />
                  </ProductIconButton>
                  <ProductIconButton label="取消新增" onClick={() => setAdding(false)}>
                    <DeleteIcon boxSize={3.5} />
                  </ProductIconButton>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </ProductModal>

      <TagOptionsDialog
        tag={optionsTag}
        onClose={() => setOptionsTag(null)}
        onSave={async (options, renames) => {
          if (!optionsTag) return;
          await updateTag(optionsTag, { options, renames });
          props.onChanged();
          setOptionsTag(null);
          toast.success('标签选项已更新');
        }}
      />

      <ProductModal
        open={Boolean(deleteTarget)}
        title="删除标签"
        onClose={() => !busy && setDeleteTarget(null)}
        footer={
          <>
            <ProductButton onClick={() => setDeleteTarget(null)} disabled={busy}>
              取消
            </ProductButton>
            <ProductButton
              tone="danger"
              busy={busy}
              onClick={() => deleteTarget && void remove(deleteTarget)}
            >
              确认删除
            </ProductButton>
          </>
        }
      >
        <p className="kb2-confirm-copy">
          删除“{deleteTarget?.label}”后，文件上的该标签值也会被移除。
        </p>
        <ProductError error={error} />
      </ProductModal>
    </>
  );
}

type TagOptionDraft = { id: string; original: string; value: string };

function TagOptionsDialog(props: {
  tag: Tag | null;
  onClose: () => void;
  onSave: (options: string[], renames: Array<{ from: string; to: string }>) => Promise<void>;
}) {
  const [rows, setRows] = useState<TagOptionDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    if (!props.tag) return;
    setRows(
      (props.tag.options ?? []).map((option) => ({
        id: globalThis.crypto.randomUUID(),
        original: option,
        value: option,
      })),
    );
    setError(null);
    setBusy(false);
  }, [props.tag]);

  const focusRow = (index: number) => {
    window.setTimeout(() => inputRefs.current[index]?.focus(), 0);
  };

  const addRow = () => {
    setRows((current) => {
      if (current.at(-1)?.value.trim() === '') {
        focusRow(current.length - 1);
        return current;
      }
      focusRow(current.length);
      return [...current, { id: globalThis.crypto.randomUUID(), original: '', value: '' }];
    });
  };

  const save = async () => {
    const options = rows.map((row) => row.value.trim()).filter(Boolean);
    if (new Set(options).size !== options.length) {
      setError(new Error('选项名称不能重复。'));
      return;
    }
    const renames = rows.flatMap((row) => {
      const from = row.original.trim();
      const to = row.value.trim();
      return from && to && from !== to ? [{ from, to }] : [];
    });
    setBusy(true);
    setError(null);
    try {
      await props.onSave(options, renames);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ProductModal
      open={Boolean(props.tag)}
      title={`管理选项 · ${props.tag?.label ?? ''}`}
      description="每一行是一个独立选项，可以包含逗号；回车保存当前项并进入下一行。"
      onClose={() => !busy && props.onClose()}
      footer={
        <>
          <ProductButton onClick={props.onClose} disabled={busy}>
            取消
          </ProductButton>
          <ProductButton tone="primary" busy={busy} onClick={() => void save()}>
            保存
          </ProductButton>
        </>
      }
    >
      <div className="kb2-tag-option-list">
        {rows.map((row, index) => (
          <div className="kb2-tag-option-row" key={row.id}>
            <ProductInput
              ref={(element) => {
                inputRefs.current[index] = element;
              }}
              value={row.value}
              aria-label={`选项 ${index + 1}`}
              placeholder="输入选项"
              onChange={(event) =>
                setRows((current) =>
                  current.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, value: event.target.value } : item,
                  ),
                )
              }
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                if (index === rows.length - 1) addRow();
                else focusRow(index + 1);
              }}
            />
            <ProductIconButton
              label={`删除选项 ${index + 1}`}
              tone="danger"
              onClick={() => {
                if (!window.confirm('确认删除这个选项？已使用该选项的文件会同步移除该值。')) {
                  return;
                }
                setRows((current) => current.filter((_, itemIndex) => itemIndex !== index));
              }}
            >
              <DeleteIcon boxSize={3.5} />
            </ProductIconButton>
          </div>
        ))}
      </div>
      <ProductButton size="sm" onClick={addRow}>
        <AddIcon boxSize={3.5} />
        添加选项
      </ProductButton>
      <ProductError error={error} />
    </ProductModal>
  );
}

export function LegacyResourcePermissionDialog(props: {
  target: {
    kind: 'space' | 'directory' | 'source';
    id: string;
    name: string;
    version: number;
    source?: Source;
  } | null;
  space?: KnowledgeSpace;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useProductToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [memberId, setMemberId] = useState('');
  const [role, setRole] = useState<Collaborator['role']>('read');
  const [principalType, setPrincipalType] =
    useState<Acl['entries'][number]['principalType']>('member');
  const [principalId, setPrincipalId] = useState('');
  const [permission, setPermission] = useState<Acl['entries'][number]['permission']>('read');
  const [activeVersion, setActiveVersion] = useState(0);
  const [activeSource, setActiveSource] = useState<Source | null>(null);
  const [pendingTransition, setPendingTransition] = useState<'disable' | 'detach' | null>(null);
  const acl = useQuery({
    queryKey: ['kb-product', 'acl', props.target?.kind, props.target?.id],
    queryFn: () => getAcl(props.target!.kind, props.target!.id),
    enabled: Boolean(props.target),
  });
  const collaborators = useQuery({
    queryKey: ['kb-product', 'collaborators', props.target?.id],
    queryFn: () => listCollaborators(props.target!.id),
    enabled: props.target?.kind === 'space',
  });

  useEffect(() => {
    setError(null);
    setMemberId('');
    setPrincipalId('');
    setActiveVersion(props.target?.version ?? 0);
    setActiveSource(props.target?.source ?? null);
    setPendingTransition(null);
  }, [props.target]);

  const addSpaceCollaborator = async (event: FormEvent) => {
    event.preventDefault();
    if (!props.target || props.target.kind !== 'space' || !memberId.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await addCollaborator(props.target.id, { memberId: memberId.trim(), role });
      await Promise.all([acl.refetch(), collaborators.refetch()]);
      props.onChanged();
      setMemberId('');
      toast.success('协作者已添加');
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const removeSpaceCollaborator = async (collaborator: Collaborator) => {
    if (!props.target) return;
    setBusy(true);
    setError(null);
    try {
      await removeCollaborator(props.target.id, collaborator);
      await Promise.all([acl.refetch(), collaborators.refetch()]);
      props.onChanged();
      toast.success('协作者已移除');
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const addAclEntry = async (event: FormEvent) => {
    event.preventDefault();
    if (!props.target || !acl.data || !principalId.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await updateAcl(
        props.target.kind,
        props.target.id,
        {
          inheritMode: 'override',
          entries: [
            ...acl.data.entries,
            { principalType, principalId: principalId.trim(), permission },
          ],
        },
        activeVersion,
      );
      await acl.refetch();
      if (props.target.kind === 'source' && activeSource) {
        const refreshed = await getSource(activeSource.id);
        setActiveSource(refreshed);
        setActiveVersion(refreshed.version);
      } else {
        setActiveVersion((value) => value + 1);
      }
      props.onChanged();
      setPrincipalId('');
      toast.success('权限条目已添加');
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const transition = async (action: 'enable' | 'disable' | 'detach' | 'resume-inherit') => {
    if (!activeSource) return;
    setBusy(true);
    setError(null);
    try {
      await transitionSourcePermission(activeSource, action);
      const refreshed = await getSource(activeSource.id);
      setActiveSource(refreshed);
      setActiveVersion(refreshed.version);
      await acl.refetch();
      props.onChanged();
      toast.success('Source 权限状态已更新');
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const requestTransition = (action: 'enable' | 'disable' | 'detach' | 'resume-inherit') => {
    if (action === 'disable' || action === 'detach') {
      setPendingTransition(action);
      return;
    }
    void transition(action);
  };

  return (
    <>
      <ProductModal
        open={Boolean(props.target)}
        title="权限配置"
        description={props.target?.name}
        size="lg"
        onClose={() => !busy && props.onClose()}
      >
        <ProductError error={error ?? acl.error ?? collaborators.error} />
        <div className="kb2-note">
          {acl.data
            ? `ACL：${acl.data.permissionState} / ${acl.data.inheritMode} · 权限版本 ${acl.data.permissionRevision}`
            : '正在读取 ACL'}
        </div>
        {props.target?.kind === 'source' && activeSource ? (
          <div className="kb2-permission-actions">
            {!props.space?.sourcePermissionEnabled ? (
              <p className="kb2-table-muted">请先在知识库信息中开启 Source 权限总开关。</p>
            ) : acl.data?.permissionState === 'disabled' ? (
              <ProductButton size="sm" busy={busy} onClick={() => requestTransition('enable')}>
                启用 Source 权限
              </ProductButton>
            ) : acl.data?.permissionState === 'inherited' ? (
              <>
                <ProductButton size="sm" busy={busy} onClick={() => requestTransition('detach')}>
                  解除继承
                </ProductButton>
                <ProductButton
                  size="sm"
                  tone="danger"
                  busy={busy}
                  onClick={() => requestTransition('disable')}
                >
                  关闭 Source 权限
                </ProductButton>
              </>
            ) : acl.data?.permissionState === 'independent' ? (
              <>
                <ProductButton
                  size="sm"
                  busy={busy}
                  onClick={() => requestTransition('resume-inherit')}
                >
                  恢复继承
                </ProductButton>
                <ProductButton
                  size="sm"
                  tone="danger"
                  busy={busy}
                  onClick={() => requestTransition('disable')}
                >
                  关闭 Source 权限
                </ProductButton>
              </>
            ) : null}
          </div>
        ) : null}
        {props.target?.kind === 'space' ? (
          <>
            <form className="kb2-permission-add" onSubmit={addSpaceCollaborator}>
              <ProductField label="成员 ID">
                <ProductInput
                  value={memberId}
                  onChange={(event) => setMemberId(event.target.value)}
                  placeholder="输入成员标识"
                />
              </ProductField>
              <ProductField label="角色">
                <ProductSelect
                  value={role}
                  onChange={(event) => setRole(event.target.value as Collaborator['role'])}
                >
                  <option value="read">只读</option>
                  <option value="write">可写</option>
                  <option value="manage">可管理</option>
                </ProductSelect>
              </ProductField>
              <ProductButton type="submit" tone="primary" busy={busy} disabled={!memberId.trim()}>
                添加
              </ProductButton>
            </form>
            <div className="kb2-tag-manager-list">
              {(collaborators.data?.items ?? [])
                .filter((item) => item.status === 'active')
                .map((item) => (
                  <div className="kb2-tag-manager-row" key={item.memberId}>
                    <span>
                      <strong>{item.memberId}</strong>
                      <small>
                        {item.role} · {formatDate(item.grantedAt)}
                      </small>
                    </span>
                    <StatusTag value={item.role} tone="info" />
                    <ProductIconButton
                      label={`移除协作者 ${item.memberId}`}
                      tone="danger"
                      onClick={() => void removeSpaceCollaborator(item)}
                    >
                      <DeleteIcon boxSize={3.5} />
                    </ProductIconButton>
                  </div>
                ))}
            </div>
          </>
        ) : null}
        <div className="kb2-divider" />
        <h3 className="kb2-dialog-section-title">ACL 条目</h3>
        <div className="kb2-tag-manager-list">
          {(acl.data?.entries ?? []).map((entry, index) => (
            <div
              className="kb2-tag-manager-row"
              key={`${entry.principalType}-${entry.principalId}-${index}`}
            >
              <span>
                <strong>{entry.principalId}</strong>
                <small>{entry.principalType}</small>
              </span>
              <StatusTag value={entry.permission} tone="info" />
            </div>
          ))}
        </div>
        <form className="kb2-acl-add" onSubmit={addAclEntry}>
          <ProductField label="主体类型">
            <ProductSelect
              value={principalType}
              onChange={(event) =>
                setPrincipalType(event.target.value as Acl['entries'][number]['principalType'])
              }
            >
              <option value="member">成员</option>
              <option value="group">群组</option>
              <option value="org">组织</option>
              <option value="workspace">工作区</option>
            </ProductSelect>
          </ProductField>
          <ProductField label="主体 ID">
            <ProductInput
              value={principalId}
              onChange={(event) => setPrincipalId(event.target.value)}
            />
          </ProductField>
          <ProductField label="权限">
            <ProductSelect
              value={permission}
              onChange={(event) =>
                setPermission(event.target.value as Acl['entries'][number]['permission'])
              }
            >
              <option value="read">只读</option>
              <option value="write">可写</option>
              <option value="manage">可管理</option>
            </ProductSelect>
          </ProductField>
          <ProductButton
            type="submit"
            tone="primary"
            busy={busy}
            disabled={!principalId.trim() || !acl.data}
          >
            添加 ACL
          </ProductButton>
        </form>
      </ProductModal>
      <ProductModal
        open={pendingTransition !== null}
        title="确认权限变更"
        description={
          pendingTransition === 'detach'
            ? '解除继承后，该 Source 将使用独立 ACL。'
            : '关闭后，该 Source 的独立协作者配置将被清空。'
        }
        onClose={() => !busy && setPendingTransition(null)}
        footer={
          <>
            <ProductButton onClick={() => setPendingTransition(null)} disabled={busy}>
              取消
            </ProductButton>
            <ProductButton
              tone="danger"
              busy={busy}
              onClick={() => {
                if (!pendingTransition) return;
                const action = pendingTransition;
                setPendingTransition(null);
                void transition(action);
              }}
            >
              确认
            </ProductButton>
          </>
        }
      >
        <p className="kb2-confirm-copy">请确认继续执行该权限变更。</p>
      </ProductModal>
    </>
  );
}

function ResourcePermissionDialog(props: {
  target: {
    kind: 'space' | 'directory' | 'source';
    id: string;
    name: string;
    version: number;
    source?: Source;
  } | null;
  space?: KnowledgeSpace;
  onClose: () => void;
  onChanged: () => void;
}) {
  return (
    <CollaboratorManagerDialog
      target={props.target}
      space={props.space}
      onClose={props.onClose}
      onChanged={props.onChanged}
    />
  );
}

function TrainingErrorDialog(props: {
  open: boolean;
  sources: Source[];
  jobs: Job[];
  onClose: () => void;
  onRefresh: () => void;
  onOpenSource: (source: Source) => void;
}) {
  const toast = useProductToast();
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const sourceById = new Map(props.sources.map((source) => [source.id, source]));
  const groups = Array.from(
    props.jobs.reduce((result, job) => {
      const current = result.get(job.resourceId) ?? [];
      current.push(job);
      result.set(job.resourceId, current);
      return result;
    }, new Map<string, Job[]>()),
  );
  const retry = async (job: Job) => {
    setBusyJobId(job.jobId);
    setError(null);
    try {
      await controlJob('retry', job);
      props.onRefresh();
      toast.success('已提交重试');
    } catch (caught) {
      setError(caught);
    } finally {
      setBusyJobId(null);
    }
  };
  const retryAll = async () => {
    setBusyJobId('all');
    setError(null);
    try {
      for (const job of props.jobs) {
        await controlJob('retry', job);
      }
      props.onRefresh();
      toast.success('已提交全部重试');
    } catch (caught) {
      setError(caught);
    } finally {
      setBusyJobId(null);
    }
  };
  const removeSource = async (source: Source) => {
    setError(null);
    try {
      await deleteSource(source);
      props.onRefresh();
      toast.success('文件已删除');
    } catch (caught) {
      setError(caught);
    }
  };
  return (
    <ProductModal
      open={props.open}
      title="训练异常列表"
      description="按来源查看失败任务和可执行操作"
      width="800px"
      onClose={props.onClose}
      footer={
        <>
          <ProductButton onClick={props.onClose}>关闭</ProductButton>
          {props.jobs.length > 0 ? (
            <ProductButton
              tone="primary"
              busy={busyJobId === 'all'}
              onClick={() => void retryAll()}
            >
              重试全部
            </ProductButton>
          ) : null}
        </>
      }
    >
      <ProductError error={error} />
      {groups.length === 0 ? (
        <ProductEmpty title="暂无训练异常" description="当前知识库中的训练任务均未报告异常。" />
      ) : (
        <div className="kb2-training-error-groups">
          {groups.map(([sourceId, jobs], groupIndex) => {
            const source = sourceById.get(sourceId);
            const sourceWritable = source && permissionRank(source.effectivePermission) >= 20;
            return (
              <section key={sourceId} className="kb2-training-error-group">
                <header>
                  <strong>
                    {groupIndex + 1}. {source?.name ?? '已删除来源'}
                  </strong>
                  {source && sourceWritable ? (
                    <ProductButton size="sm" onClick={() => props.onOpenSource(source)}>
                      编辑
                    </ProductButton>
                  ) : null}
                  {source && permissionRank(source.effectivePermission) >= 40 ? (
                    <ProductButton
                      size="sm"
                      tone="danger"
                      onClick={() => void removeSource(source)}
                    >
                      删除
                    </ProductButton>
                  ) : null}
                </header>
                <div className="kb2-training-error-table" role="table">
                  {jobs.map((job) => (
                    <div key={job.jobId} className="kb2-training-error-table__row" role="row">
                      <span role="cell">{jobStageLabel(String(job.progress.stage))}</span>
                      <strong role="cell">{job.error?.code ?? '训练任务失败'}</strong>
                      <span role="cell">
                        <ProductButton
                          size="sm"
                          busy={busyJobId === job.jobId}
                          disabled={!sourceWritable}
                          onClick={() => void retry(job)}
                        >
                          重试
                        </ProductButton>
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </ProductModal>
  );
}

function trainingStageItems(source: Source, job?: Job) {
  const settings = source.chunkSettings ?? {};
  const labels = [
    source.kind === 'image' ? '图片解析' : '内容解析',
    ...(settings.trainingType === 'qa' ? ['问答生成'] : []),
    ...(settings.imageIndex === true ? ['图片索引'] : []),
    ...(settings.autoIndexes === true ? ['补充索引'] : []),
    '向量化',
    '已就绪',
  ];
  const failedStage = job?.error
    ? job.kind === 'parse'
      ? labels[0]
      : job.kind === 'qa'
        ? '问答生成'
        : job.kind === 'caption'
          ? '图片解析'
          : job.kind === 'index'
            ? '向量化'
            : null
    : null;
  const activeLabel =
    source.processingStatus === 'parsing'
      ? labels[0]
      : source.processingStatus === 'indexing'
        ? '向量化'
        : source.processingStatus === 'rebuilding'
          ? '向量化'
          : source.processingStatus === 'queued'
            ? labels[0]
            : source.processingStatus === 'failed'
              ? failedStage
              : null;
  const activeIndex = activeLabel ? Math.max(0, labels.indexOf(activeLabel)) : -1;
  return labels.map((label, index) => ({
    label,
    active: label === activeLabel,
    done: activeIndex >= 0 && index < activeIndex,
  }));
}

function TrainingDialog(props: {
  source: Source | null;
  job?: Job;
  jobs: Job[];
  isAdmin: boolean;
  onClose: () => void;
  onRetried: () => void;
}) {
  const toast = useProductToast();
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [sourceName, setSourceName] = useState('');
  const [tab, setTab] = useState<'states' | 'errors'>('states');
  const sourceJobs = props.source
    ? props.jobs.filter(
        (job) =>
          job.knowledgeSpaceId === props.source?.knowledgeSpaceId &&
          job.resourceType === 'source' &&
          job.resourceId === props.source?.id,
      )
    : [];
  const failedJobs = sourceJobs.filter((job) => ['failed', 'dead_letter'].includes(job.status));
  const actions = props.job ? jobActionsFor(props.job.status, props.isAdmin) : [];
  const actionLabel: Record<S6JobAction, string> = {
    retry: '重试任务',
    cancel: '取消任务',
    pause: '暂停',
    resume: '恢复',
    replay: '重新投递',
  };

  useEffect(() => {
    if (!editing) setSourceName(props.source?.name ?? '');
  }, [editing, props.source?.name]);

  const runControl = async (action: S6JobAction, job: Job) => {
    const key = `${action}:${job.jobId}`;
    setBusyAction(key);
    setError(null);
    try {
      await controlJob(action, job);
      props.onRetried();
      toast.success(action === 'retry' ? '已提交重试' : `已提交${actionLabel[action]}`);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusyAction(null);
    }
  };

  const retryAll = async () => {
    setBusy(true);
    setError(null);
    try {
      for (const job of failedJobs) {
        await controlJob('retry', job);
      }
      props.onRetried();
      toast.success('已提交重试');
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const saveSource = async (event: FormEvent) => {
    event.preventDefault();
    if (!props.source || !sourceName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await updateSource(props.source, { name: sourceName.trim() });
      props.onRetried();
      setEditing(false);
      toast.success('文件信息已更新');
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const removeSource = async () => {
    if (!props.source) return;
    setBusy(true);
    setError(null);
    try {
      await deleteSource(props.source);
      props.onRetried();
      setDeleting(false);
      props.onClose();
      toast.success('文件已删除');
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ProductModal
        open={Boolean(props.source)}
        title="训练状态"
        description={props.source?.name}
        width="712px"
        height="620px"
        onClose={() => !busy && props.onClose()}
        footer={
          props.job ? (
            <>
              {actions.map((action) => (
                <ProductButton
                  key={action}
                  tone={action === 'retry' || action === 'resume' ? 'primary' : 'secondary'}
                  busy={busyAction === `${action}:${props.job?.jobId}`}
                  onClick={() => void runControl(action, props.job!)}
                >
                  {actionLabel[action]}
                </ProductButton>
              ))}
            </>
          ) : undefined
        }
      >
        <ProductError error={error} />
        {props.source ? (
          <div className="kb2-training-view">
            <div className="kb2-segment-tabs" role="tablist" aria-label="训练状态视图">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'states'}
                onClick={() => setTab('states')}
              >
                训练状态
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'errors'}
                onClick={() => setTab('errors')}
              >
                异常({failedJobs.length})
              </button>
            </div>
            {tab === 'states' ? (
              <div className="kb2-training-steps">
                {trainingStageItems(props.source, props.job).map((item) => {
                  const current = props.source?.processingStatus;
                  const ready = current === 'ready';
                  const failed = current === 'failed' && item.active;
                  return (
                    <div
                      key={item.label}
                      className={`kb2-training-step${item.active ? ' is-active' : ''}${ready || item.done ? ' is-done' : ''}${failed ? ' is-failed' : ''}`}
                    >
                      <span className="kb2-training-step__dot" aria-hidden="true">
                        {ready || item.done ? <CheckIcon boxSize={3} /> : null}
                      </span>
                      <div>
                        <strong>{item.label}</strong>
                        <span>
                          {failed
                            ? (props.job?.error?.code ?? '训练异常')
                            : item.active
                              ? jobStageLabel(String(props.job?.progress.stage ?? current ?? ''))
                              : ready || item.done
                                ? '已完成'
                                : '等待处理'}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <section className="kb2-training-errors" aria-label="分组训练异常">
                <div className="kb2-training-errors__header">
                  <div>
                    <h3>{props.source.name}</h3>
                    <p>
                      {failedJobs.length > 0 ? `${failedJobs.length} 条待处理异常` : '暂无任务异常'}
                    </p>
                  </div>
                  {failedJobs.length > 0 ? (
                    <ProductButton busy={busy} onClick={() => void retryAll()}>
                      重试全部
                    </ProductButton>
                  ) : null}
                </div>
                {failedJobs.map((job) => (
                  <div className="kb2-training-error-row" key={job.jobId}>
                    <div>
                      <strong>{job.error?.code ?? '任务失败'}</strong>
                      <span>{jobStageLabel(String(job.progress.stage))}</span>
                    </div>
                    <div className="kb2-training-error-row__actions">
                      <ProductButton
                        busy={busyAction === `retry:${job.jobId}`}
                        onClick={() => void runControl('retry', job)}
                      >
                        重试
                      </ProductButton>
                      <ProductButton
                        onClick={() => {
                          setSourceName(props.source?.name ?? '');
                          setEditing(true);
                        }}
                      >
                        编辑
                      </ProductButton>
                      <ProductButton tone="danger" onClick={() => setDeleting(true)}>
                        删除
                      </ProductButton>
                    </div>
                  </div>
                ))}
              </section>
            )}
          </div>
        ) : null}
      </ProductModal>

      <ProductModal
        open={editing}
        title="编辑文件信息"
        description={props.source?.name}
        onClose={() => !busy && setEditing(false)}
        footer={
          <>
            <ProductButton onClick={() => setEditing(false)} disabled={busy}>
              取消
            </ProductButton>
            <ProductButton
              tone="primary"
              busy={busy}
              onClick={() =>
                (
                  document.getElementById('kb2-training-source-edit') as HTMLFormElement | null
                )?.requestSubmit()
              }
            >
              保存
            </ProductButton>
          </>
        }
      >
        <form id="kb2-training-source-edit" onSubmit={saveSource}>
          <ProductField label="名称">
            <ProductInput
              value={sourceName}
              onChange={(event) => setSourceName(event.target.value)}
              maxLength={240}
              autoFocus
            />
          </ProductField>
          <ProductError error={error} />
        </form>
      </ProductModal>

      <ProductModal
        open={deleting}
        title="删除文件与训练异常"
        description="删除后关联数据块和训练任务可能同时删除。"
        onClose={() => !busy && setDeleting(false)}
        footer={
          <>
            <ProductButton onClick={() => setDeleting(false)} disabled={busy}>
              取消
            </ProductButton>
            <ProductButton tone="danger" busy={busy} onClick={() => void removeSource()}>
              确认删除
            </ProductButton>
          </>
        }
      >
        <p className="kb2-confirm-copy">
          确认删除 <strong>{props.source?.name}</strong>？
        </p>
        <ProductError error={error} />
      </ProductModal>
    </>
  );
}
