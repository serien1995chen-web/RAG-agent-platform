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
  TimeIcon,
  WarningIcon,
} from '@chakra-ui/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  addCollaborator,
  applyTags,
  archiveSources,
  batchSources,
  createDirectory,
  createTag,
  deleteDirectory,
  deleteSource,
  deleteTag,
  downloadSource,
  getAcl,
  getConnector,
  listCollaborators,
  moveDirectory,
  moveSource,
  productApi,
  removeCollaborator,
  retryJob,
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
  directoryPath,
  descendantDirectoryIds,
  filterSourceRows,
  hasActiveSourceStatus,
  latestJobsByResource,
  normalizeDetailTab,
  sourceKindLabel,
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
  Source,
  Tag,
} from './types';
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
import { ImportWorkspace } from './import-workspace';
import { SearchWorkspace } from './search-workspace';

export interface DatasetDetailQuery {
  datasetId: string;
  currentTab?: string;
  parentId?: string;
  collectionId?: string;
  source?: string;
}

type DetailQueryChange = (query: DatasetDetailQuery, options?: { replace?: boolean }) => void;

const ACTIVE_JOB_STATUSES = new Set(['queued', 'running', 'retry_wait', 'paused']);

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
  const [batchMode, setBatchMode] = useState(false);
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [rowMenuId, setRowMenuId] = useState<string | null>(null);
  const [sourceToggleBusyId, setSourceToggleBusyId] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<unknown>(null);
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
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const [tagAssignmentTarget, setTagAssignmentTarget] = useState<Source | null>(null);
  const [tagAssignmentId, setTagAssignmentId] = useState('');
  const [tagAssignmentValue, setTagAssignmentValue] = useState('');
  const [tagAssignmentBusy, setTagAssignmentBusy] = useState(false);
  const [tagAssignmentError, setTagAssignmentError] = useState<unknown>(null);
  const [permissionTarget, setPermissionTarget] = useState<{
    kind: 'space' | 'directory' | 'source';
    id: string;
    name: string;
    source?: Source;
  } | null>(null);
  const [editDatasetOpen, setEditDatasetOpen] = useState(false);
  const [editDatasetName, setEditDatasetName] = useState('');
  const [editDatasetDescription, setEditDatasetDescription] = useState('');
  const [editDatasetBusy, setEditDatasetBusy] = useState(false);
  const [editDatasetError, setEditDatasetError] = useState<unknown>(null);
  const [trainingSource, setTrainingSource] = useState<Source | null>(null);

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
  const activeJobs = jobs.filter(
    (job) => job.knowledgeSpaceId === datasetId && ACTIVE_JOB_STATUSES.has(job.status),
  );
  const selectedTag = tags.find((tag) => tag.id === tagId);
  const batchTag = tags.find((tag) => tag.id === batchTagId);
  const assignmentTag = tags.find((tag) => tag.id === tagAssignmentId);

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
    try {
      const ticket = await archiveSources(
        datasetId,
        selectedSources.map((source) => source.id),
      );
      window.open(ticket.url, '_blank', 'noopener,noreferrer');
      toast.success('下载任务已开始');
    } catch (error) {
      setBatchError(error);
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
      await applyTags(
        selectedSources.map((source) => ({
          sourceId: source.id,
          tagId: batchTag.id,
          value: parseTagInput(batchTag, batchTagValue),
        })),
      );
      await invalidateCollection();
      setBatchDialog(null);
      toast.success('标签设置成功');
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
    setTagAssignmentId('');
    setTagAssignmentValue('');
    setTagAssignmentError(null);
  };

  const assignSourceTag = async () => {
    if (!tagAssignmentTarget || !assignmentTag) return;
    setTagAssignmentBusy(true);
    setTagAssignmentError(null);
    try {
      await applyTags([
        {
          sourceId: tagAssignmentTarget.id,
          tagId: assignmentTag.id,
          value: parseTagInput(assignmentTag, tagAssignmentValue),
        },
      ]);
      await invalidateCollection();
      setTagAssignmentTarget(null);
      toast.success('标签设置成功');
    } catch (error) {
      setTagAssignmentError(error);
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

  const toggleSourcePermission = async (enabled: boolean) => {
    if (!space) return;
    try {
      await updateSpace(space.id, {
        version: space.version,
        sourcePermissionEnabled: enabled,
      });
      await invalidateCollection();
      toast.success(enabled ? 'Source 权限已开启' : 'Source 权限已关闭');
    } catch (error) {
      toast.error(error);
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
          <div className="kb2-detail-nav__status">
            {activeJobs.length > 0 ? (
              <StatusTag value={`${activeJobs.length} 个任务处理中`} tone="info" dot />
            ) : (
              <StatusTag value="无进行中任务" tone="neutral" />
            )}
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
              sources={sources}
              onEdit={openEditDataset}
              onPermission={() =>
                space && setPermissionTarget({ kind: 'space', id: space.id, name: space.name })
              }
              onSourcePermissionChange={(enabled) => void toggleSourcePermission(enabled)}
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
                      onClick={() => {
                        const first = sources.find(
                          (source) => latestJobs.get(source.id)?.status === 'failed',
                        );
                        if (first) setTrainingSource(first);
                      }}
                    >
                      <WarningIcon boxSize={3.5} />
                      异常列表 {failedJobs.length}
                    </ProductButton>
                  ) : null}
                  <ProductButton size="sm" onClick={() => setTagManagerOpen(true)}>
                    标签管理
                  </ProductButton>
                  <ProductButton size="sm" onClick={() => openDirectory()}>
                    <AddIcon boxSize={3.5} />
                    新建目录
                  </ProductButton>
                  <ProductButton
                    size="sm"
                    tone="primary"
                    onClick={() =>
                      navigate({
                        datasetId,
                        currentTab: 'import',
                        ...(currentDirectoryId ? { parentId: currentDirectoryId } : {}),
                        source: 'fileLocal',
                      })
                    }
                  >
                    <ExternalLinkIcon boxSize={3.5} />
                    新建 / 导入
                  </ProductButton>
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
                        <th>标签</th>
                        <th>类型</th>
                        <th>数据量</th>
                        <th>状态</th>
                        <th>启用</th>
                        <th aria-label="操作" />
                      </tr>
                    </thead>
                    <tbody>
                      {currentDirectories.map((directory) => (
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
                          <td>文件夹</td>
                          <td>—</td>
                          <td>
                            <StatusTag value="目录" tone="neutral" />
                          </td>
                          <td>—</td>
                          <td>
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
                                <ProductMenuItem
                                  icon={<EditIcon boxSize={3.5} />}
                                  onClick={() => {
                                    setRowMenuId(null);
                                    openDirectory(directory);
                                  }}
                                >
                                  编辑目录
                                </ProductMenuItem>
                                <ProductMenuItem
                                  icon={<CopyIcon boxSize={3.5} />}
                                  onClick={() => {
                                    setRowMenuId(null);
                                    openMoveDirectory(directory);
                                  }}
                                >
                                  移动
                                </ProductMenuItem>
                                <ProductMenuItem
                                  icon={<LockIcon boxSize={3.5} />}
                                  onClick={() => {
                                    setRowMenuId(null);
                                    setPermissionTarget({
                                      kind: 'directory',
                                      id: directory.id,
                                      name: directory.name,
                                    });
                                  }}
                                >
                                  权限
                                </ProductMenuItem>
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
                              </ProductMenu>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {currentSources.map((source) => {
                        const status = sourceStatusView(source.processingStatus);
                        const sourceTags = tagValuesForSource(source, tags);
                        const job = latestJobs.get(source.id);
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
                                  <small className="kb2-inline-code">{source.id}</small>
                                </span>
                              </button>
                            </td>
                            <td>
                              <div className="kb2-tag-list">
                                {sourceTags.length > 0 ? (
                                  sourceTags.slice(0, 2).map((tag) => (
                                    <span key={`${tag.id}-${tag.value}`} className="kb2-mini-tag">
                                      {tag.label}:{tag.value}
                                    </span>
                                  ))
                                ) : (
                                  <span className="kb2-table-muted">未设置</span>
                                )}
                                {sourceTags.length > 2 ? (
                                  <span className="kb2-mini-tag">+{sourceTags.length - 2}</span>
                                ) : null}
                              </div>
                            </td>
                            <td>{sourceKindLabel(source.kind)}</td>
                            <td>{source.segmentCount ?? '后端未提供'}</td>
                            <td>
                              <button
                                type="button"
                                className="kb2-status-button"
                                onClick={() => setTrainingSource(source)}
                                aria-label={`${source.name} 的训练状态`}
                              >
                                <StatusTag value={status.label} tone={status.tone} dot />
                              </button>
                            </td>
                            <td>
                              <label className="kb2-switch">
                                <input
                                  type="checkbox"
                                  checked={source.searchEnabled}
                                  disabled={sourceToggleBusyId === source.id}
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
                                <ProductIconButton
                                  label={`${source.name} 的更多操作`}
                                  onClick={() =>
                                    setRowMenuId(rowMenuId === source.id ? null : source.id)
                                  }
                                >
                                  <span className="kb2-more-dots">···</span>
                                </ProductIconButton>
                                <ProductMenu
                                  open={rowMenuId === source.id}
                                  onClose={() => setRowMenuId(null)}
                                >
                                  <ProductMenuItem
                                    icon={<DownloadIcon boxSize={3.5} />}
                                    onClick={() => void downloadOne(source)}
                                  >
                                    下载原始文件
                                  </ProductMenuItem>
                                  <ProductMenuItem
                                    icon={<AttachmentIcon boxSize={3.5} />}
                                    onClick={() => openTagAssignment(source)}
                                  >
                                    标签设置
                                  </ProductMenuItem>
                                  <ProductMenuItem
                                    icon={<LockIcon boxSize={3.5} />}
                                    onClick={() => {
                                      setRowMenuId(null);
                                      setPermissionTarget({
                                        kind: 'source',
                                        id: source.id,
                                        name: source.name,
                                        source,
                                      });
                                    }}
                                  >
                                    Source 权限
                                  </ProductMenuItem>
                                  <ProductMenuItem
                                    icon={<CopyIcon boxSize={3.5} />}
                                    onClick={() => openMoveSource(source)}
                                  >
                                    移动
                                  </ProductMenuItem>
                                  {job ? (
                                    <ProductMenuItem
                                      icon={<TimeIcon boxSize={3.5} />}
                                      onClick={() => {
                                        setRowMenuId(null);
                                        setTrainingSource(source);
                                      }}
                                    >
                                      训练详情
                                    </ProductMenuItem>
                                  ) : null}
                                  <ProductMenuItem
                                    icon={<DeleteIcon boxSize={3.5} />}
                                    danger
                                    onClick={() => {
                                      setRowMenuId(null);
                                      setDeleteSourceTarget(source);
                                      setDeleteError(null);
                                    }}
                                  >
                                    删除文件
                                  </ProductMenuItem>
                                </ProductMenu>
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
                sources={sources}
                onEdit={openEditDataset}
                onPermission={() =>
                  space && setPermissionTarget({ kind: 'space', id: space.id, name: space.name })
                }
                onSourcePermissionChange={(enabled) => void toggleSourcePermission(enabled)}
                onChanged={() => void invalidateCollection()}
              />
            )}
          </div>
        )}

        {batchMode && selectedSourceIds.length > 0 ? (
          <div className="kb2-batch-bar" role="region" aria-label="Collection 批量操作">
            <span className="kb2-batch-bar__count">已选择 {selectedSourceIds.length} 个文件</span>
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
              disabled={!assignmentTag}
              onClick={() => void assignSourceTag()}
            >
              保存
            </ProductButton>
          </>
        }
      >
        <TagValueEditor
          tags={tags}
          selectedTagId={tagAssignmentId}
          value={tagAssignmentValue}
          onTagChange={(value) => {
            setTagAssignmentId(value);
            setTagAssignmentValue('');
          }}
          onValueChange={setTagAssignmentValue}
          tag={assignmentTag}
        />
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

      <TrainingDialog
        source={trainingSource}
        job={trainingSource ? latestJobs.get(trainingSource.id) : undefined}
        onClose={() => setTrainingSource(null)}
        onRetried={() => void invalidateCollection()}
      />
    </ProductAppShell>
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
  sources: Source[];
  onEdit: () => void;
  onPermission: () => void;
  onSourcePermissionChange: (enabled: boolean) => void;
  onChanged: () => void;
}) {
  const toast = useProductToast();
  const [modelsOpen, setModelsOpen] = useState(false);
  const [modelDraft, setModelDraft] = useState<Record<string, string>>({});
  const [modelsBusy, setModelsBusy] = useState(false);
  const [modelsError, setModelsError] = useState<unknown>(null);
  const [connectorBusy, setConnectorBusy] = useState(false);
  const [connectorError, setConnectorError] = useState<unknown>(null);
  const type = productTypeOf(props.space?.iconKey);
  const binding = (modelType: ModelBinding['modelType']) =>
    props.bindings.find((entry) => entry.modelType === modelType && entry.status === 'active');
  const connectorId = props.sources.find((source) => source.connectorId)?.connectorId;
  const connectorQuery = useQuery({
    queryKey: ['kb-product', 'connector', connectorId],
    queryFn: () => getConnector(connectorId!),
    enabled: Boolean(connectorId),
  });
  const authorizedModels = (type: Model['type']) =>
    props.models.filter((model) => model.type === type && model.authorized);

  const openModels = () => {
    setModelDraft({
      llm: binding('llm')?.modelId ?? '',
      embedding: binding('embedding')?.modelId ?? '',
      vlm: binding('vlm')?.modelId ?? '',
    });
    setModelsError(null);
    setModelsOpen(true);
  };

  const saveModels = async () => {
    if (!props.space) return;
    setModelsBusy(true);
    setModelsError(null);
    try {
      const next = (['llm', 'embedding', 'vlm'] as const).flatMap((modelType) => {
        const model = props.models.find((item) => item.modelId === modelDraft[modelType]);
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
      await updateModelBindings(props.space.id, next, props.space.version);
      props.onChanged();
      setModelsOpen(false);
      toast.success('模型配置已更新');
    } catch (caught) {
      setModelsError(caught);
    } finally {
      setModelsBusy(false);
    }
  };

  const syncDataSource = async () => {
    const connector = connectorQuery.data;
    if (!connector) return;
    setConnectorBusy(true);
    setConnectorError(null);
    try {
      await syncConnector(connector.id, {
        full: false,
        expectedCursorVersion: connector.cursorVersion,
        reason: 'manual_ui_sync',
      });
      props.onChanged();
      toast.success('同步任务已提交');
    } catch (caught) {
      setConnectorError(caught);
    } finally {
      setConnectorBusy(false);
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
            <ProductIconButton label="编辑模型配置" onClick={openModels}>
              <EditIcon boxSize={3.5} />
            </ProductIconButton>
          </div>
          <InfoLine label="索引模型" value={binding('embedding')?.displayName ?? '后端未提供'} />
          <InfoLine label="文本理解模型" value={binding('llm')?.displayName ?? '后端未提供'} />
          <InfoLine label="图片理解模型" value={binding('vlm')?.displayName ?? '未设置'} />
          {props.models.length === 0 ? (
            <div className="kb2-table-muted">模型目录暂不可用</div>
          ) : null}
        </div>
        <div className="kb2-info-group">
          <h3>数据源同步</h3>
          {connectorId ? (
            <>
              <InfoLine label="连接器" value={connectorQuery.data?.provider ?? connectorId} />
              <InfoLine label="状态" value={connectorQuery.data?.status ?? '正在读取'} />
              <InfoLine
                label="上次同步"
                value={formatDate(connectorQuery.data?.lastSuccessAt ?? undefined)}
              />
              <ProductButton
                size="sm"
                className="kb2-full-button"
                busy={connectorBusy}
                disabled={!connectorQuery.data}
                onClick={() => void syncDataSource()}
              >
                <RepeatIcon boxSize={3.5} />
                立即同步
              </ProductButton>
              <ProductError error={connectorError ?? connectorQuery.error} />
            </>
          ) : (
            <div className="kb2-table-muted">当前知识库没有外部数据源连接器。</div>
          )}
        </div>
        <div className="kb2-info-group">
          <h3>权限</h3>
          <label className="kb2-switch-row">
            <span>
              <strong>Source 权限</strong>
              <small>开启后可配置每个 Source 的独立协作者</small>
            </span>
            <span className="kb2-switch">
              <input
                type="checkbox"
                checked={props.space?.sourcePermissionEnabled ?? false}
                onChange={(event) => props.onSourcePermissionChange(event.target.checked)}
                aria-label="Source 权限总开关"
              />
              <span />
            </span>
          </label>
          <ProductButton size="sm" className="kb2-full-button" onClick={props.onPermission}>
            <LockIcon boxSize={3.5} />
            管理知识库权限
          </ProductButton>
        </div>
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
            <ProductButton tone="primary" busy={modelsBusy} onClick={() => void saveModels()}>
              保存
            </ProductButton>
          </>
        }
      >
        <div className="kb2-form-grid">
          <ProductField label="索引模型">
            <ProductSelect
              value={modelDraft.embedding ?? ''}
              onChange={(event) =>
                setModelDraft((current) => ({ ...current, embedding: event.target.value }))
              }
            >
              <option value="">未设置</option>
              {authorizedModels('embedding').map((model) => (
                <option key={model.modelId} value={model.modelId}>
                  {model.displayName}
                </option>
              ))}
            </ProductSelect>
          </ProductField>
          <ProductField label="文本理解模型">
            <ProductSelect
              value={modelDraft.llm ?? ''}
              onChange={(event) =>
                setModelDraft((current) => ({ ...current, llm: event.target.value }))
              }
            >
              <option value="">未设置</option>
              {authorizedModels('llm').map((model) => (
                <option key={model.modelId} value={model.modelId}>
                  {model.displayName}
                </option>
              ))}
            </ProductSelect>
          </ProductField>
          <ProductField label="图片理解模型">
            <ProductSelect
              value={modelDraft.vlm ?? ''}
              onChange={(event) =>
                setModelDraft((current) => ({ ...current, vlm: event.target.value }))
              }
            >
              <option value="">未设置</option>
              {authorizedModels('vlm').map((model) => (
                <option key={model.modelId} value={model.modelId}>
                  {model.displayName}
                </option>
              ))}
            </ProductSelect>
          </ProductField>
        </div>
        <ProductError error={modelsError} />
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
  return (
    <aside className="kb2-info-panel" aria-label="目录信息">
      <div className="kb2-info-panel__headline">
        <ProductTypeIcon kind="folder" />
        <div>
          <h2>{props.directory.name}</h2>
          <StatusTag value={`层级 ${props.directory.depth}`} tone="warning" />
        </div>
      </div>
      <div className="kb2-folder-panel__actions">
        <ProductButton size="sm" onClick={props.onEdit}>
          <EditIcon boxSize={3.5} />
          编辑
        </ProductButton>
        <ProductButton size="sm" onClick={props.onMove}>
          <CopyIcon boxSize={3.5} />
          移动
        </ProductButton>
        <ProductButton size="sm" onClick={props.onPermission}>
          <LockIcon boxSize={3.5} />
          权限
        </ProductButton>
        <ProductButton size="sm" tone="danger" onClick={props.onDelete}>
          <DeleteIcon boxSize={3.5} />
          删除
        </ProductButton>
      </div>
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

function TagManagerDialog(props: {
  open: boolean;
  spaceId: string;
  tags: Tag[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useProductToast();
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [tagType, setTagType] = useState<Tag['tagType']>('array');
  const [options, setOptions] = useState('');
  const [required, setRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<Tag | null>(null);
  const [editingLabel, setEditingLabel] = useState('');

  useEffect(() => {
    if (!props.open) return;
    setKey('');
    setLabel('');
    setOptions('');
    setRequired(false);
    setEditing(null);
    setError(null);
  }, [props.open]);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createTag(props.spaceId, {
        key,
        label,
        tagType,
        required,
        options:
          tagType === 'string' || tagType === 'array'
            ? options
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean)
            : null,
      });
      props.onChanged();
      setKey('');
      setLabel('');
      setOptions('');
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
      toast.success('标签已删除');
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ProductModal
      open={props.open}
      title="标签管理"
      description="标签定义属于当前知识库，可应用到文件和批量操作。"
      size="lg"
      onClose={() => !busy && props.onClose()}
    >
      <form className="kb2-tag-create" onSubmit={add}>
        <ProductField label="标签键">
          <ProductInput
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder="department"
            pattern="[a-z][a-z0-9_]{1,63}"
          />
        </ProductField>
        <ProductField label="显示名称">
          <ProductInput value={label} onChange={(event) => setLabel(event.target.value)} />
        </ProductField>
        <ProductField label="类型">
          <ProductSelect
            value={tagType}
            onChange={(event) => setTagType(event.target.value as Tag['tagType'])}
          >
            <option value="array">选项</option>
            <option value="string">字符串</option>
            <option value="number">数字</option>
            <option value="datetime">日期</option>
          </ProductSelect>
        </ProductField>
        {tagType === 'string' || tagType === 'array' ? (
          <ProductField label="可选项" hint="英文逗号分隔">
            <ProductInput value={options} onChange={(event) => setOptions(event.target.value)} />
          </ProductField>
        ) : null}
        <div className="kb2-checkbox-row">
          <ProductCheckbox checked={required} onChange={setRequired} label="必填标签" />
          <span>必填标签</span>
        </div>
        <ProductButton type="submit" tone="primary" busy={busy} disabled={!key || !label}>
          添加标签
        </ProductButton>
      </form>
      <ProductError error={error} />
      <div className="kb2-tag-manager-list">
        {props.tags.length === 0 ? (
          <div className="kb2-center-state">尚未定义标签</div>
        ) : (
          props.tags.map((tag) => (
            <div className="kb2-tag-manager-row" key={tag.id}>
              {editing?.id === tag.id ? (
                <ProductInput
                  value={editingLabel}
                  onChange={(event) => setEditingLabel(event.target.value)}
                  autoFocus
                />
              ) : (
                <span>
                  <strong>{tag.label}</strong>
                  <small>
                    {tag.key} · {tag.tagType} · 版本 {tag.version}
                  </small>
                </span>
              )}
              <StatusTag
                value={tag.status === 'active' ? '启用' : '停用'}
                tone={tag.status === 'active' ? 'success' : 'neutral'}
              />
              {editing?.id === tag.id ? (
                <ProductButton
                  size="sm"
                  tone="primary"
                  busy={busy}
                  onClick={() => void rename(tag)}
                >
                  保存
                </ProductButton>
              ) : (
                <ProductIconButton
                  label={`编辑标签 ${tag.label}`}
                  onClick={() => {
                    setEditing(tag);
                    setEditingLabel(tag.label);
                  }}
                >
                  <EditIcon boxSize={3.5} />
                </ProductIconButton>
              )}
              <ProductIconButton
                label={`删除标签 ${tag.label}`}
                tone="danger"
                onClick={() => void remove(tag)}
              >
                <DeleteIcon boxSize={3.5} />
              </ProductIconButton>
            </div>
          ))
        )}
      </div>
    </ProductModal>
  );
}

function ResourcePermissionDialog(props: {
  target: {
    kind: 'space' | 'directory' | 'source';
    id: string;
    name: string;
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
      await updateAcl(props.target.kind, props.target.id, {
        inheritMode: 'override',
        permissionState: 'independent',
        permissionRevision: acl.data.permissionRevision,
        snapshotVersion: acl.data.snapshotVersion,
        entries: [
          ...acl.data.entries,
          { principalType, principalId: principalId.trim(), permission },
        ],
      });
      await acl.refetch();
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
    if (!props.target?.source) return;
    setBusy(true);
    setError(null);
    try {
      await transitionSourcePermission(props.target.source, action);
      await acl.refetch();
      props.onChanged();
      toast.success('Source 权限状态已更新');
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
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
      {props.target?.kind === 'source' && props.target.source ? (
        <div className="kb2-permission-actions">
          <ProductButton size="sm" busy={busy} onClick={() => void transition('enable')}>
            启用独立权限
          </ProductButton>
          <ProductButton size="sm" busy={busy} onClick={() => void transition('resume-inherit')}>
            恢复继承
          </ProductButton>
          <ProductButton
            size="sm"
            tone="danger"
            busy={busy}
            onClick={() => void transition('disable')}
          >
            关闭 Source 权限
          </ProductButton>
          <ProductButton
            size="sm"
            tone="danger"
            busy={busy}
            onClick={() => void transition('detach')}
          >
            解除权限
          </ProductButton>
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
  );
}

function TrainingDialog(props: {
  source: Source | null;
  job?: Job;
  onClose: () => void;
  onRetried: () => void;
}) {
  const toast = useProductToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const retry = async () => {
    if (!props.job) return;
    setBusy(true);
    setError(null);
    try {
      await retryJob(props.job);
      props.onRetried();
      toast.success('已提交重试');
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  return (
    <ProductModal
      open={Boolean(props.source)}
      title="训练与索引状态"
      description={props.source?.name}
      onClose={() => !busy && props.onClose()}
      footer={
        props.job && ['failed', 'dead_letter'].includes(props.job.status) ? (
          <ProductButton tone="primary" busy={busy} onClick={() => void retry()}>
            重试任务
          </ProductButton>
        ) : undefined
      }
    >
      <ProductError error={error} />
      {props.source ? (
        <div className="kb2-training-view">
          <div className="kb2-training-summary">
            <StatusTag
              value={sourceStatusView(props.source.processingStatus).label}
              tone={sourceStatusView(props.source.processingStatus).tone}
              dot
            />
            <span>Source 版本 {props.source.sourceVersion}</span>
          </div>
          {props.job ? (
            <>
              <InfoLine label="任务类型" value={props.job.kind} />
              <InfoLine label="任务状态" value={props.job.status} />
              <InfoLine label="当前阶段" value={props.job.progress.stage} />
              <InfoLine
                label="进度"
                value={`${props.job.progress.completed}/${props.job.progress.total} · ${props.job.progress.percent}%`}
              />
              <div className="kb2-progress-track">
                <span
                  style={{ width: `${Math.max(0, Math.min(100, props.job.progress.percent))}%` }}
                />
              </div>
              {props.job.error ? (
                <div className="kb2-error-panel">
                  <WarningIcon boxSize={4} />
                  <div>
                    <strong>{props.job.error.code ?? '任务失败'}</strong>
                    <span>错误详情由后端任务记录提供，请根据任务 ID 排查。</span>
                  </div>
                </div>
              ) : null}
              <div className="kb2-note">任务 ID：{props.job.jobId}</div>
            </>
          ) : (
            <div className="kb2-note">
              后端没有返回该 Source 的任务记录，当前只展示 Source 状态。
            </div>
          )}
        </div>
      ) : null}
    </ProductModal>
  );
}
