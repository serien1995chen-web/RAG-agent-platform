'use client';

import {
  AddIcon,
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  DeleteIcon,
  DownloadIcon,
  EditIcon,
  ExternalLinkIcon,
  LockIcon,
} from '@chakra-ui/icons';
import { Spinner } from '@chakra-ui/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import {
  addCollaborator,
  batchSpaces,
  connectConnector,
  deleteSpace,
  exportSpace,
  getAcl,
  listCollaborators,
  moveSpace,
  productApi,
  productSession,
  removeCollaborator,
  updateSpace,
} from './api';
import type { Acl, BatchResult, Collaborator, KnowledgeSpace, PermissionLevel } from './types';
import { ProductAppShell } from './shell';
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
  ProductStat,
  StatusTag,
  ProductTypeIcon,
  formatDate,
  productTypeOf,
  useProductToast,
} from './ui';
import {
  batchDeleteConfirmation as getBatchDeleteConfirmation,
  breadcrumbSpacePath,
  descendantSpaceIds,
  filterAndSortSpaces,
  spaceStatusView,
  type SpaceFilterType,
  type SpaceSort,
} from './dataset-list-state';

type CreatableType = 'general' | 'folder' | 'api' | 'feishu' | 'yuque' | 'dingtalk';

const PAGE_SIZE = 30;

function permissionRank(permission: PermissionLevel | null | undefined): number {
  return permission ? { read: 10, write: 20, manage: 30, owner: 40 }[permission] : 0;
}

const CREATE_OPTIONS: Array<{
  type: CreatableType;
  title: string;
  description: string;
  icon: typeof CopyIcon;
}> = [
  {
    type: 'general',
    title: '通用知识库',
    description: '上传文件、网页或自定义文本',
    icon: CopyIcon,
  },
  { type: 'folder', title: '文件夹', description: '整理知识库并控制访问权限', icon: CopyIcon },
  {
    type: 'api',
    title: 'API 文件库',
    description: '连接符合协议的外部文件服务',
    icon: ExternalLinkIcon,
  },
  {
    type: 'feishu',
    title: '飞书知识库',
    description: '从飞书目录导入文档',
    icon: ExternalLinkIcon,
  },
  {
    type: 'yuque',
    title: '语雀知识库',
    description: '从语雀知识库导入文档',
    icon: ExternalLinkIcon,
  },
  {
    type: 'dingtalk',
    title: '钉钉知识库',
    description: '从钉钉知识库导入文档',
    icon: ExternalLinkIcon,
  },
];

function iconKeyOf(type: CreatableType) {
  if (type === 'folder') return 'folder';
  if (type === 'general') return 'book-open';
  return `connector:${type}`;
}

function createLabel(type: CreatableType) {
  return CREATE_OPTIONS.find((option) => option.type === type)?.title ?? '知识库';
}

export function DatasetListPage(props: { parentId: string }) {
  const queryClient = useQueryClient();
  const toast = useProductToast();
  const [parentId, setParentId] = useState(props.parentId);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<SpaceFilterType>('all');
  const [ownerFilter, setOwnerFilter] = useState('');
  const [sort, setSort] = useState<SpaceSort>('-updatedAt');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [createType, setCreateType] = useState<CreatableType>('general');
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createDescription, setCreateDescription] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [authorization, setAuthorization] = useState('');
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [folderToken, setFolderToken] = useState('');
  const [yuqueUserId, setYuqueUserId] = useState('');
  const [yuqueToken, setYuqueToken] = useState('');
  const [dingAppKey, setDingAppKey] = useState('');
  const [dingAppSecret, setDingAppSecret] = useState('');
  const [dingUserId, setDingUserId] = useState('');
  const [dingWorkspaceId, setDingWorkspaceId] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);
  const [editTarget, setEditTarget] = useState<KnowledgeSpace | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<unknown>(null);
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeSpace | null>(null);
  const [deleteText, setDeleteText] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<unknown>(null);
  const [moveTarget, setMoveTarget] = useState<KnowledgeSpace | null>(null);
  const [moveParentId, setMoveParentId] = useState<string>('');
  const [moveBusy, setMoveBusy] = useState(false);
  const [moveError, setMoveError] = useState<unknown>(null);
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchMoveOpen, setBatchMoveOpen] = useState(false);
  const [batchTargetId, setBatchTargetId] = useState('');
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [batchDeleteText, setBatchDeleteText] = useState('');
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchError, setBatchError] = useState<unknown>(null);
  const [batchResult, setBatchResult] = useState<BatchResult | null>(null);
  const [permissionTarget, setPermissionTarget] = useState<KnowledgeSpace | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [dragConfirm, setDragConfirm] = useState<{
    source: KnowledgeSpace;
    target: KnowledgeSpace;
  } | null>(null);
  const createNameRef = useRef<HTMLInputElement>(null);
  const editNameRef = useRef<HTMLInputElement>(null);
  const deleteRef = useRef<HTMLInputElement>(null);

  const spacesQuery = useQuery({
    queryKey: ['kb-product', 'spaces', sort],
    queryFn: () => productApi.listSpaces(sort),
  });
  const sessionQuery = useQuery({
    queryKey: ['kb-product', 'session'],
    queryFn: productSession,
  });
  const canCreate =
    sessionQuery.data?.isWorkspaceOwner === true ||
    sessionQuery.data?.scopes.includes('knowledge:write') === true;
  const allSpaces = spacesQuery.data ?? [];
  const currentFolder = allSpaces.find((space) => space.id === parentId);
  const currentPath = breadcrumbSpacePath(allSpaces, currentFolder);
  const byId = useMemo(() => new Map(allSpaces.map((space) => [space.id, space])), [allSpaces]);
  const currentItems = useMemo(
    () => allSpaces.filter((space) => (space.parentSpaceId ?? '') === (parentId || '')),
    [allSpaces, parentId],
  );
  const folderCount = currentItems.filter((space) => space.kind === 'folder').length;
  const knowledgeCount = currentItems.filter((space) => space.kind === 'space').length;
  const ownerOptions = useMemo(
    () => [...new Set(currentItems.map((space) => space.ownershipMemberId))].sort(),
    [currentItems],
  );
  const filteredItems = useMemo(
    () =>
      filterAndSortSpaces(currentItems, {
        search,
        owner: ownerFilter,
        type: typeFilter,
        sort,
      }),
    [currentItems, ownerFilter, search, sort, typeFilter],
  );
  const visibleItems = filteredItems.slice(0, visibleCount);
  const selectableItems = filteredItems.filter((space) => space.kind === 'space');
  const selectedSpaces = allSpaces.filter((space) => selectedIds.includes(space.id));
  const invalidParent = Boolean(parentId) && !spacesQuery.isLoading && !currentFolder;

  useEffect(() => {
    setParentId(props.parentId);
  }, [props.parentId]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
    setSelectedIds([]);
    setMenuOpenId(null);
  }, [parentId, search, typeFilter, ownerFilter, sort]);

  useEffect(() => {
    try {
      const stored = JSON.parse(
        globalThis.localStorage.getItem('kb-product-list-filters') ?? '{}',
      ) as {
        typeFilter?: SpaceFilterType;
        sort?: SpaceSort;
      };
      if (stored.typeFilter) setTypeFilter(stored.typeFilter);
      if (stored.sort) setSort(stored.sort);
    } catch {
      // Ignore unavailable or malformed local preferences.
    }
  }, []);

  useEffect(() => {
    globalThis.localStorage.setItem(
      'kb-product-list-filters',
      JSON.stringify({ typeFilter, sort }),
    );
  }, [sort, typeFilter]);

  useEffect(() => {
    if (!createOpen) return;
    const timer = setTimeout(() => createNameRef.current?.focus(), 60);
    return () => clearTimeout(timer);
  }, [createOpen]);

  useEffect(() => {
    if (!editTarget) return;
    const timer = setTimeout(() => editNameRef.current?.focus(), 60);
    return () => clearTimeout(timer);
  }, [editTarget]);

  useEffect(() => {
    if (!deleteTarget) return;
    const timer = setTimeout(() => deleteRef.current?.focus(), 60);
    return () => clearTimeout(timer);
  }, [deleteTarget]);

  const navigateToParent = (nextId: string) => {
    const url = nextId ? `/dataset/list?parentId=${encodeURIComponent(nextId)}` : '/dataset/list';
    window.location.assign(url);
  };

  const openCreate = (type: CreatableType) => {
    setCreateType(type);
    setCreateName('');
    setCreateDescription('');
    setBaseUrl('');
    setAuthorization('');
    setAppId('');
    setAppSecret('');
    setFolderToken('');
    setYuqueUserId('');
    setYuqueToken('');
    setDingAppKey('');
    setDingAppSecret('');
    setDingUserId('');
    setDingWorkspaceId('');
    setCreateError(null);
    setCreateMenuOpen(false);
    setCreateOpen(true);
  };

  const connectorPayload = () => {
    if (createType === 'api') {
      return {
        provider: 'custom_api' as const,
        config: {
          provider: 'custom_api' as const,
          baseUrl,
          catalogPath: '/v1/file/list' as const,
          detailPath: '/v1/file/detail' as const,
          contentPath: '/v1/file/content' as const,
          previewPath: '/v1/file/read' as const,
          pageMode: 'none' as const,
        },
        credentials: {
          provider: 'custom_api' as const,
          authMode: authorization ? ('bearer' as const) : ('none' as const),
          ...(authorization ? { authorization } : {}),
        },
      };
    }
    if (createType === 'feishu') {
      return {
        provider: 'feishu' as const,
        config: { provider: 'feishu' as const, folderToken },
        credentials: { provider: 'feishu' as const, appId, appSecret },
      };
    }
    if (createType === 'yuque') {
      return {
        provider: 'yuque' as const,
        config: { provider: 'yuque' as const },
        credentials: { provider: 'yuque' as const, userId: yuqueUserId, token: yuqueToken },
      };
    }
    return {
      provider: 'dingtalk' as const,
      config: {
        provider: 'dingtalk' as const,
        ...(dingWorkspaceId ? { workspaceId: dingWorkspaceId } : {}),
      },
      credentials: {
        provider: 'dingtalk' as const,
        appKey: dingAppKey,
        appSecret: dingAppSecret,
        userId: dingUserId,
      },
    };
  };

  const submitCreate = async (event: FormEvent) => {
    event.preventDefault();
    const name = createName.trim();
    if (!name) {
      setCreateError(new Error('请输入名称'));
      createNameRef.current?.focus();
      return;
    }
    if (createType !== 'general' && createType !== 'folder') {
      if (createType === 'api' && (!baseUrl || !authorization)) {
        setCreateError(new Error('请填写 API 地址和访问令牌'));
        return;
      }
      if (createType === 'feishu' && (!appId || !appSecret || !folderToken)) {
        setCreateError(new Error('请填写飞书应用凭证和目录标识'));
        return;
      }
      if (createType === 'yuque' && (!yuqueUserId || !yuqueToken)) {
        setCreateError(new Error('请填写语雀用户和令牌'));
        return;
      }
      if (createType === 'dingtalk' && (!dingAppKey || !dingAppSecret || !dingUserId)) {
        setCreateError(new Error('请填写钉钉应用凭证和用户标识'));
        return;
      }
    }
    setCreateBusy(true);
    setCreateError(null);
    try {
      const created = await productApi.createSpace({
        kind: createType === 'folder' ? 'folder' : 'space',
        parentSpaceId: parentId || null,
        name,
        description: createDescription.trim(),
        iconKey: iconKeyOf(createType),
        accessMode: 'workspace',
        sourceAclMode: 'inherited',
        sourcePermissionEnabled: true,
      });
      if (createType !== 'general' && createType !== 'folder') {
        const payload = connectorPayload();
        await connectConnector(created.id, payload.provider, {
          name: name,
          config: payload.config,
          credentials: payload.credentials,
          syncEnabled: true,
          syncIntervalMinutes: 60,
        });
      }
      await queryClient.invalidateQueries({ queryKey: ['kb-product', 'spaces'] });
      setCreateOpen(false);
      toast.success(createType === 'folder' ? '文件夹创建成功' : '知识库创建成功');
      if (createType !== 'folder') {
        window.location.assign(`/dataset/detail?datasetId=${encodeURIComponent(created.id)}`);
      }
    } catch (error) {
      setCreateError(error);
    } finally {
      setCreateBusy(false);
    }
  };

  const openEdit = (space: KnowledgeSpace) => {
    setEditTarget(space);
    setEditName(space.name);
    setEditDescription(space.description ?? '');
    setEditError(null);
    setMenuOpenId(null);
  };

  const submitEdit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editTarget || !editName.trim()) return;
    setEditBusy(true);
    setEditError(null);
    try {
      await updateSpace(editTarget.id, {
        version: editTarget.version,
        name: editName.trim(),
        description: editDescription.trim(),
      });
      await queryClient.invalidateQueries({ queryKey: ['kb-product', 'spaces'] });
      setEditTarget(null);
      toast.success('信息已更新');
    } catch (error) {
      setEditError(error);
    } finally {
      setEditBusy(false);
    }
  };

  const submitDelete = async (event: FormEvent) => {
    event.preventDefault();
    if (!deleteTarget || deleteText !== deleteTarget.name) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await deleteSpace(deleteTarget);
      await queryClient.invalidateQueries({ queryKey: ['kb-product', 'spaces'] });
      if (deleteTarget.id === parentId) navigateToParent(deleteTarget.parentSpaceId ?? '');
      setDeleteTarget(null);
      setDeleteText('');
      toast.success('删除成功');
    } catch (error) {
      setDeleteError(error);
    } finally {
      setDeleteBusy(false);
    }
  };

  const submitMove = async (event: FormEvent) => {
    event.preventDefault();
    if (!moveTarget) return;
    setMoveBusy(true);
    setMoveError(null);
    try {
      await moveSpace(moveTarget, moveParentId || null);
      await queryClient.invalidateQueries({ queryKey: ['kb-product', 'spaces'] });
      setMoveTarget(null);
      toast.success('移动成功');
    } catch (error) {
      setMoveError(error);
    } finally {
      setMoveBusy(false);
    }
  };

  const runBatch = async (action: 'move' | 'delete') => {
    if (selectedSpaces.length === 0) return;
    setBatchBusy(true);
    setBatchError(null);
    setBatchResult(null);
    try {
      const result = await batchSpaces(
        action,
        selectedSpaces,
        action === 'move' ? batchTargetId || null : undefined,
      );
      setBatchResult(result);
      const failedIds = result.items.filter((item) => !item.success).map((item) => item.id);
      setSelectedIds(failedIds);
      setBatchMoveOpen(false);
      setBatchDeleteOpen(false);
      setBatchDeleteText('');
      if (result.failed === 0) {
        setBatchMode(false);
        toast.success(action === 'move' ? '移动成功' : '删除成功');
      } else if (result.succeeded === 0) {
        toast.error(new Error(action === 'move' ? '移动失败' : '删除失败'));
      } else {
        toast.warning('批量操作部分失败');
      }
      await queryClient.invalidateQueries({ queryKey: ['kb-product', 'spaces'] });
    } catch (error) {
      setBatchError(error);
      toast.error(error);
    } finally {
      setBatchBusy(false);
    }
  };

  const runExport = async (space: KnowledgeSpace) => {
    setMenuOpenId(null);
    const pendingWindow = window.open('about:blank', '_blank');
    if (pendingWindow) pendingWindow.opener = null;
    try {
      let job = await exportSpace(space.id);
      const deadline = Date.now() + 30_000;
      while (['queued', 'running', 'retry_wait', 'paused'].includes(job.status)) {
        if (Date.now() >= deadline) throw new Error('导出任务等待超时');
        await new Promise((resolveWait) => window.setTimeout(resolveWait, 500));
        job = await productApi.getJob(job.jobId);
      }
      if (job.status !== 'succeeded') throw new Error('导出任务失败');
      const blobId = String(job.result?.objectBlobRefId ?? '');
      if (!blobId) throw new Error('导出结果缺少对象引用');
      const ticket = await productApi.downloadFile(blobId);
      if (pendingWindow) {
        pendingWindow.location.replace(ticket.url);
      } else {
        const link = document.createElement('a');
        link.href = ticket.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.click();
      }
      toast.success('导出完成');
    } catch (error) {
      pendingWindow?.close();
      toast.error(error);
    }
  };

  const dropIntoFolder = async (target: KnowledgeSpace) => {
    if (!draggingId || draggingId === target.id) {
      setDraggingId(null);
      setDropTargetId(null);
      return;
    }
    const source = byId.get(draggingId);
    setDraggingId(null);
    setDropTargetId(null);
    if (!source) return;
    const descendants = descendantSpaceIds(allSpaces, source.id);
    if (descendants.has(target.id)) {
      toast.warning('不能移动到自身或其子文件夹');
      return;
    }
    setDragConfirm({ source, target });
  };

  const confirmDragMove = async () => {
    if (!dragConfirm) return;
    setMoveBusy(true);
    try {
      await moveSpace(dragConfirm.source, dragConfirm.target.id);
      await queryClient.invalidateQueries({ queryKey: ['kb-product', 'spaces'] });
      setDragConfirm(null);
      toast.success('移动成功');
    } catch (error) {
      toast.error(error);
    } finally {
      setMoveBusy(false);
    }
  };

  const batchDeleteConfirmation = getBatchDeleteConfirmation(selectedSpaces);
  const moveTargets = allSpaces.filter((space) => {
    if (space.kind !== 'folder') return false;
    if (
      moveTarget &&
      (space.id === moveTarget.id || descendantSpaceIds(allSpaces, moveTarget.id).has(space.id))
    ) {
      return false;
    }
    return true;
  });

  return (
    <ProductAppShell active="knowledge" title={currentFolder?.name ?? '我的知识库'}>
      <ProductPage>
        <ProductPageHeader
          breadcrumbs={
            <>
              <button type="button" onClick={() => navigateToParent('')}>
                我的知识库
              </button>
              {currentPath.map((folder) => (
                <span key={folder.id} className="kb2-breadcrumb-segment">
                  <ChevronRightIcon boxSize={3} />
                  {folder.id === currentFolder?.id ? (
                    <strong>{folder.name}</strong>
                  ) : (
                    <button type="button" onClick={() => navigateToParent(folder.id)}>
                      {folder.name}
                    </button>
                  )}
                </span>
              ))}
            </>
          }
          title={currentFolder?.name ?? '我的知识库'}
          description={
            currentFolder?.description ||
            '集中管理和组织知识库。选择文件夹可继续浏览，选择一个知识库可进入其数据集。'
          }
          actions={
            <>
              <ProductButton
                tone={batchMode ? 'primary' : 'secondary'}
                onClick={() => {
                  setBatchMode((value) => !value);
                  setSelectedIds([]);
                }}
                disabled={selectableItems.length === 0}
              >
                <CheckIcon boxSize={3.5} />
                批量管理
              </ProductButton>
              {canCreate ? (
                <div className="kb2-new-wrap">
                  <ProductButton
                    tone="primary"
                    onClick={() => setCreateMenuOpen((value) => !value)}
                    aria-expanded={createMenuOpen}
                    aria-haspopup="menu"
                  >
                    <AddIcon boxSize={3.5} />
                    新建
                  </ProductButton>
                  <ProductMenu
                    open={createMenuOpen}
                    onClose={() => setCreateMenuOpen(false)}
                    align="right"
                  >
                    {CREATE_OPTIONS.map((option) => (
                      <ProductMenuItem
                        key={option.type}
                        icon={<option.icon boxSize={3.5} />}
                        hint={option.description}
                        onClick={() => openCreate(option.type)}
                      >
                        {option.title}
                      </ProductMenuItem>
                    ))}
                  </ProductMenu>
                </div>
              ) : null}
            </>
          }
        />

        <ProductError error={spacesQuery.error} onRetry={() => void spacesQuery.refetch()} />
        <ProductError error={batchError} />
        {batchResult ? (
          <div className="kb2-note" role="status">
            批量操作结果：成功 {batchResult.succeeded} 项，失败 {batchResult.failed}{' '}
            项。失败项已保留选中。
          </div>
        ) : null}
        {invalidParent ? (
          <div className="kb2-note" role="alert">
            当前文件夹不存在或已被删除。
            <button type="button" className="kb2-link-button" onClick={() => navigateToParent('')}>
              返回知识库根目录
            </button>
          </div>
        ) : null}

        <div className="kb2-stat-row">
          <ProductStat label="当前目录资源" value={currentItems.length} />
          <ProductStat label="知识库" value={knowledgeCount} />
          <ProductStat label="文件夹" value={folderCount} />
          <ProductStat label="已选择" value={selectedIds.length} />
        </div>

        <div className={`kb2-list-layout${currentFolder ? '' : ' kb2-list-layout--root'}`}>
          <section aria-label="知识库列表">
            <div className="kb2-toolbar">
              <div className="kb2-toolbar__summary">
                共 {filteredItems.length} 项{search.trim() ? '（已按搜索过滤）' : ''}
              </div>
              <div className="kb2-toolbar__controls">
                <ProductSearchBox
                  value={search}
                  onChange={setSearch}
                  placeholder="搜索当前目录"
                  maxLength={30}
                />
                <ProductSelect
                  aria-label="按类型筛选"
                  value={typeFilter}
                  onChange={(event) => setTypeFilter(event.target.value as SpaceFilterType)}
                >
                  <option value="all">全部类型</option>
                  <option value="folder">文件夹</option>
                  <option value="general">通用知识库</option>
                  <option value="api">API 文件库</option>
                  <option value="feishu">飞书知识库</option>
                  <option value="yuque">语雀知识库</option>
                  <option value="dingtalk">钉钉知识库</option>
                </ProductSelect>
                <ProductSelect
                  aria-label="按创建者筛选"
                  value={ownerFilter}
                  onChange={(event) => setOwnerFilter(event.target.value)}
                >
                  <option value="">全部创建者</option>
                  {ownerOptions.map((owner) => (
                    <option value={owner} key={owner}>
                      {owner}
                    </option>
                  ))}
                </ProductSelect>
                <ProductSelect
                  aria-label="排序"
                  value={sort}
                  onChange={(event) => setSort(event.target.value as SpaceSort)}
                >
                  <option value="-updatedAt">最近修改</option>
                  <option value="-createdAt">创建时间倒序</option>
                  <option value="createdAt">创建时间正序</option>
                  <option value="name">按名称</option>
                </ProductSelect>
              </div>
            </div>

            {spacesQuery.isLoading ? (
              <ProductSkeleton />
            ) : filteredItems.length === 0 ? (
              <ProductEmpty
                title={
                  search || typeFilter !== 'all' || ownerFilter
                    ? '没有匹配的知识库'
                    : '这里还没有知识库'
                }
                description={
                  search || typeFilter !== 'all' || ownerFilter
                    ? '尝试调整搜索、类型或创建者筛选条件。'
                    : '创建一个知识库，或先建立文件夹整理后续资源。'
                }
                action={
                  canCreate ? (
                    <ProductButton tone="primary" onClick={() => openCreate('general')}>
                      <AddIcon boxSize={3.5} />
                      创建知识库
                    </ProductButton>
                  ) : undefined
                }
              />
            ) : (
              <>
                <div className="kb2-card-grid">
                  {visibleItems.map((space) => {
                    const type = productTypeOf(space.kind === 'folder' ? 'folder' : space.iconKey);
                    const status = spaceStatusView(space.status);
                    const selected = selectedIds.includes(space.id);
                    const effectivePermission =
                      sessionQuery.data?.isWorkspaceOwner ||
                      sessionQuery.data?.memberId === space.ownershipMemberId
                        ? 'owner'
                        : (space.effectivePermission ?? null);
                    const permissionRank = effectivePermission
                      ? { read: 10, write: 20, manage: 30, owner: 40 }[effectivePermission]
                      : 0;
                    const canWrite = permissionRank >= 20;
                    const canManage = permissionRank >= 30;
                    const canOwn = permissionRank >= 40;
                    return (
                      <article
                        key={space.id}
                        className={[
                          'kb2-kb-card',
                          selected ? 'kb2-kb-card--selected' : '',
                          space.kind === 'folder' && dropTargetId === space.id
                            ? 'kb2-kb-card--drop-target'
                            : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        draggable={!batchMode && canWrite}
                        onDragStart={(event: DragEvent<HTMLElement>) => {
                          setDraggingId(space.id);
                          event.dataTransfer.effectAllowed = 'move';
                          event.dataTransfer.setData('text/plain', space.id);
                        }}
                        onDragEnd={() => {
                          setDraggingId(null);
                          setDropTargetId(null);
                        }}
                        onDragOver={(event) => {
                          if (space.kind !== 'folder' || !draggingId || draggingId === space.id)
                            return;
                          event.preventDefault();
                          event.dataTransfer.dropEffect = 'move';
                          setDropTargetId(space.id);
                        }}
                        onDragLeave={() => {
                          if (dropTargetId === space.id) setDropTargetId(null);
                        }}
                        onDrop={(event) => {
                          if (space.kind !== 'folder') return;
                          event.preventDefault();
                          void dropIntoFolder(space);
                        }}
                      >
                        <div className="kb2-kb-card__top">
                          {batchMode ? (
                            <ProductCheckbox
                              checked={selected}
                              onChange={(checked) =>
                                setSelectedIds((current) =>
                                  checked
                                    ? [...new Set([...current, space.id])]
                                    : current.filter((id) => id !== space.id),
                                )
                              }
                              label={`选择 ${space.name}`}
                              disabled={space.kind === 'folder'}
                            />
                          ) : (
                            <ProductTypeIcon kind={type.kind} />
                          )}
                          <button
                            type="button"
                            className="kb2-kb-card__title kb2-reset-button"
                            onClick={() => {
                              if (batchMode && space.kind === 'space') {
                                setSelectedIds((current) =>
                                  selected
                                    ? current.filter((id) => id !== space.id)
                                    : [...current, space.id],
                                );
                                return;
                              }
                              if (space.kind === 'folder') {
                                navigateToParent(space.id);
                              } else {
                                window.location.assign(
                                  `/dataset/detail?datasetId=${encodeURIComponent(space.id)}`,
                                );
                              }
                            }}
                          >
                            <strong title={space.name}>{space.name}</strong>
                            <span>{type.label}</span>
                          </button>
                          {!batchMode && canWrite ? (
                            <div className="kb2-kb-card__menu-wrap">
                              <ProductIconButton
                                label={`${space.name} 的更多操作`}
                                className="kb2-kb-card__more"
                                onClick={() =>
                                  setMenuOpenId(menuOpenId === space.id ? null : space.id)
                                }
                              >
                                <span className="kb2-more-dots" aria-hidden="true">
                                  ···
                                </span>
                              </ProductIconButton>
                              <ProductMenu
                                open={menuOpenId === space.id}
                                onClose={() => setMenuOpenId(null)}
                                align="right"
                              >
                                {canWrite ? (
                                  <ProductMenuItem
                                    icon={<EditIcon boxSize={3.5} />}
                                    onClick={() => openEdit(space)}
                                  >
                                    编辑信息
                                  </ProductMenuItem>
                                ) : null}
                                {canWrite ? (
                                  <ProductMenuItem
                                    icon={<CopyIcon boxSize={3.5} />}
                                    onClick={() => {
                                      setMenuOpenId(null);
                                      setMoveTarget(space);
                                      setMoveParentId(space.parentSpaceId ?? '');
                                      setMoveError(null);
                                    }}
                                  >
                                    移动
                                  </ProductMenuItem>
                                ) : null}
                                {canManage ? (
                                  <ProductMenuItem
                                    icon={<LockIcon boxSize={3.5} />}
                                    onClick={() => {
                                      setMenuOpenId(null);
                                      setPermissionTarget(space);
                                    }}
                                  >
                                    权限
                                  </ProductMenuItem>
                                ) : null}
                                {space.kind === 'space' ? (
                                  <ProductMenuItem
                                    icon={<DownloadIcon boxSize={3.5} />}
                                    onClick={() => void runExport(space)}
                                  >
                                    导出
                                  </ProductMenuItem>
                                ) : null}
                                {canOwn ? (
                                  <ProductMenuItem
                                    icon={<DeleteIcon boxSize={3.5} />}
                                    danger
                                    onClick={() => {
                                      setMenuOpenId(null);
                                      setDeleteTarget(space);
                                      setDeleteText('');
                                      setDeleteError(null);
                                    }}
                                  >
                                    删除
                                  </ProductMenuItem>
                                ) : null}
                              </ProductMenu>
                            </div>
                          ) : null}
                        </div>
                        <p className="kb2-kb-card__description">
                          {space.description ||
                            (space.kind === 'folder'
                              ? '用于整理知识库和访问权限。'
                              : '这个知识库还没有介绍。')}
                        </p>
                        <div className="kb2-kb-card__footer">
                          <span title={space.ownershipMemberId}>{space.ownershipMemberId}</span>
                          <span>{formatDate(space.updatedAt)}</span>
                          <StatusTag value={status.label} tone={status.tone} dot />
                        </div>
                      </article>
                    );
                  })}
                </div>
                {visibleCount < filteredItems.length ? (
                  <div className="kb2-load-more">
                    <ProductButton onClick={() => setVisibleCount((value) => value + PAGE_SIZE)}>
                      加载更多（剩余 {filteredItems.length - visibleCount}）
                    </ProductButton>
                  </div>
                ) : null}
              </>
            )}
          </section>

          {currentFolder ? (
            <aside className="kb2-folder-panel" aria-label="当前文件夹详情">
              <div className="kb2-folder-panel__heading">
                <ProductTypeIcon kind="folder" />
                <h2 title={currentFolder.name}>{currentFolder.name}</h2>
              </div>
              <p>{currentFolder.description || '这个文件夹还没有介绍。'}</p>
              <div className="kb2-folder-panel__actions">
                {permissionRank(currentFolder.effectivePermission) >= 20 ? (
                  <>
                    <ProductButton size="sm" onClick={() => openEdit(currentFolder)}>
                      <EditIcon boxSize={3.5} />
                      编辑
                    </ProductButton>
                    <ProductButton
                      size="sm"
                      onClick={() => {
                        setMoveTarget(currentFolder);
                        setMoveParentId(currentFolder.parentSpaceId ?? '');
                      }}
                    >
                      <CopyIcon boxSize={3.5} />
                      移动
                    </ProductButton>
                  </>
                ) : null}
                {permissionRank(currentFolder.effectivePermission) >= 30 ? (
                  <ProductButton
                    size="sm"
                    tone="danger"
                    onClick={() => setPermissionTarget(currentFolder)}
                  >
                    <LockIcon boxSize={3.5} />
                    权限
                  </ProductButton>
                ) : null}
                {permissionRank(currentFolder.effectivePermission) >= 40 ? (
                  <ProductButton
                    size="sm"
                    tone="danger"
                    onClick={() => {
                      setDeleteTarget(currentFolder);
                      setDeleteText('');
                      setDeleteError(null);
                    }}
                  >
                    <DeleteIcon boxSize={3.5} />
                    删除
                  </ProductButton>
                ) : null}
              </div>
              <dl className="kb2-folder-panel__meta">
                <div>
                  <dt>资源数量</dt>
                  <dd>{currentItems.length}</dd>
                </div>
                <div>
                  <dt>创建者</dt>
                  <dd title={currentFolder.ownershipMemberId}>{currentFolder.ownershipMemberId}</dd>
                </div>
                <div>
                  <dt>更新时间</dt>
                  <dd>{formatDate(currentFolder.updatedAt)}</dd>
                </div>
                <div>
                  <dt>权限模式</dt>
                  <dd>{currentFolder.accessMode === 'workspace' ? '工作区可见' : '受限访问'}</dd>
                </div>
              </dl>
            </aside>
          ) : null}
        </div>

        {batchMode && selectedIds.length > 0 ? (
          <div className="kb2-batch-bar" role="region" aria-label="批量操作">
            <span className="kb2-batch-bar__count">已选择 {selectedIds.length} 个知识库</span>
            <ProductButton
              onClick={() => {
                setBatchTargetId('');
                setBatchMoveOpen(true);
              }}
              disabled={batchBusy || selectedSpaces.length === 0}
            >
              批量移动
            </ProductButton>
            <ProductButton
              tone="danger"
              onClick={() => {
                setBatchDeleteText('');
                setBatchDeleteOpen(true);
              }}
              disabled={batchBusy || selectedSpaces.length === 0}
            >
              批量删除
            </ProductButton>
            <ProductButton tone="ghost" onClick={() => setSelectedIds([])}>
              清空选择
            </ProductButton>
          </div>
        ) : null}
      </ProductPage>

      <ProductModal
        open={createOpen}
        title={`创建${createLabel(createType)}`}
        description={
          createType === 'folder'
            ? '文件夹可以继续包含知识库或子文件夹。'
            : '创建后将进入知识库详情。'
        }
        onClose={() => !createBusy && setCreateOpen(false)}
        footer={
          <>
            <ProductButton onClick={() => setCreateOpen(false)} disabled={createBusy}>
              取消
            </ProductButton>
            <ProductButton
              tone="primary"
              busy={createBusy}
              onClick={() => {
                const form = document.getElementById('kb2-create-form') as HTMLFormElement | null;
                form?.requestSubmit();
              }}
            >
              创建
            </ProductButton>
          </>
        }
      >
        <form id="kb2-create-form" className="kb2-form-grid" onSubmit={submitCreate}>
          <ProductField label="名称">
            <ProductInput
              ref={createNameRef}
              value={createName}
              onChange={(event) => setCreateName(event.target.value)}
              maxLength={30}
              placeholder={`输入${createLabel(createType)}名称`}
              required
            />
          </ProductField>
          <ProductField label="说明">
            <ProductInput
              value={createDescription}
              onChange={(event) => setCreateDescription(event.target.value)}
              maxLength={2000}
              placeholder="可选"
            />
          </ProductField>
          {createType === 'api' ? (
            <>
              <ProductField label="API 基础地址">
                <ProductInput
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder="https://example.com/api"
                  type="url"
                />
              </ProductField>
              <ProductField label="访问令牌" hint="使用 Bearer 认证；令牌只提交给后端。">
                <ProductInput
                  value={authorization}
                  onChange={(event) => setAuthorization(event.target.value)}
                  type="password"
                  autoComplete="off"
                />
              </ProductField>
            </>
          ) : null}
          {createType === 'feishu' ? (
            <>
              <ProductField label="App ID">
                <ProductInput value={appId} onChange={(event) => setAppId(event.target.value)} />
              </ProductField>
              <ProductField label="App Secret">
                <ProductInput
                  value={appSecret}
                  onChange={(event) => setAppSecret(event.target.value)}
                  type="password"
                  autoComplete="off"
                />
              </ProductField>
              <ProductField label="目录 Token">
                <ProductInput
                  value={folderToken}
                  onChange={(event) => setFolderToken(event.target.value)}
                />
              </ProductField>
            </>
          ) : null}
          {createType === 'yuque' ? (
            <>
              <ProductField label="用户 ID">
                <ProductInput
                  value={yuqueUserId}
                  onChange={(event) => setYuqueUserId(event.target.value)}
                />
              </ProductField>
              <ProductField label="访问令牌">
                <ProductInput
                  value={yuqueToken}
                  onChange={(event) => setYuqueToken(event.target.value)}
                  type="password"
                  autoComplete="off"
                />
              </ProductField>
            </>
          ) : null}
          {createType === 'dingtalk' ? (
            <>
              <ProductField label="App Key">
                <ProductInput
                  value={dingAppKey}
                  onChange={(event) => setDingAppKey(event.target.value)}
                />
              </ProductField>
              <ProductField label="App Secret">
                <ProductInput
                  value={dingAppSecret}
                  onChange={(event) => setDingAppSecret(event.target.value)}
                  type="password"
                  autoComplete="off"
                />
              </ProductField>
              <ProductField label="用户 ID">
                <ProductInput
                  value={dingUserId}
                  onChange={(event) => setDingUserId(event.target.value)}
                />
              </ProductField>
              <ProductField label="工作区 ID" hint="可选">
                <ProductInput
                  value={dingWorkspaceId}
                  onChange={(event) => setDingWorkspaceId(event.target.value)}
                />
              </ProductField>
            </>
          ) : null}
          <div className="kb2-form-grid__full">
            <ProductError error={createError} />
          </div>
        </form>
      </ProductModal>

      <ProductModal
        open={Boolean(editTarget)}
        title="编辑信息"
        onClose={() => !editBusy && setEditTarget(null)}
        footer={
          <>
            <ProductButton onClick={() => setEditTarget(null)} disabled={editBusy}>
              取消
            </ProductButton>
            <ProductButton
              tone="primary"
              busy={editBusy}
              onClick={() => {
                const form = document.getElementById('kb2-edit-form') as HTMLFormElement | null;
                form?.requestSubmit();
              }}
            >
              保存
            </ProductButton>
          </>
        }
      >
        <form id="kb2-edit-form" className="kb2-form-grid" onSubmit={submitEdit}>
          <ProductField label="名称">
            <ProductInput
              ref={editNameRef}
              value={editName}
              onChange={(event) => setEditName(event.target.value)}
              maxLength={30}
              required
            />
          </ProductField>
          <ProductField label="说明">
            <ProductInput
              value={editDescription}
              onChange={(event) => setEditDescription(event.target.value)}
              maxLength={2000}
            />
          </ProductField>
          <div className="kb2-form-grid__full">
            <ProductError error={editError} />
          </div>
        </form>
      </ProductModal>

      <ProductModal
        open={Boolean(deleteTarget)}
        title={`删除${deleteTarget?.kind === 'folder' ? '文件夹' : '知识库'}`}
        description="此操作可能同时删除内部数据，且无法自动恢复。"
        onClose={() => !deleteBusy && setDeleteTarget(null)}
        footer={
          <>
            <ProductButton onClick={() => setDeleteTarget(null)} disabled={deleteBusy}>
              取消
            </ProductButton>
            <ProductButton
              tone="danger"
              busy={deleteBusy}
              disabled={deleteText !== deleteTarget?.name}
              onClick={() => {
                const form = document.getElementById('kb2-delete-form') as HTMLFormElement | null;
                form?.requestSubmit();
              }}
            >
              确认删除
            </ProductButton>
          </>
        }
      >
        <form id="kb2-delete-form" onSubmit={submitDelete} className="kb2-form-grid">
          <div className="kb2-form-grid__full">
            <p className="kb2-confirm-copy">
              请输入完整名称 <strong>{deleteTarget?.name}</strong> 以确认删除。
            </p>
            <ProductField label="资源名称">
              <ProductInput
                ref={deleteRef}
                value={deleteText}
                onChange={(event) => setDeleteText(event.target.value)}
                autoComplete="off"
              />
            </ProductField>
            <ProductError error={deleteError} />
          </div>
        </form>
      </ProductModal>

      <ProductModal
        open={Boolean(moveTarget)}
        title={`移动${moveTarget?.kind === 'folder' ? '文件夹' : '知识库'}`}
        onClose={() => !moveBusy && setMoveTarget(null)}
        footer={
          <>
            <ProductButton onClick={() => setMoveTarget(null)} disabled={moveBusy}>
              取消
            </ProductButton>
            <ProductButton
              tone="primary"
              busy={moveBusy}
              onClick={() => {
                const form = document.getElementById('kb2-move-form') as HTMLFormElement | null;
                form?.requestSubmit();
              }}
            >
              移动
            </ProductButton>
          </>
        }
      >
        <form id="kb2-move-form" onSubmit={submitMove} className="kb2-form-grid">
          <div className="kb2-form-grid__full">
            <ProductField label="目标位置">
              <ProductSelect
                value={moveParentId}
                onChange={(event) => setMoveParentId(event.target.value)}
              >
                <option value="">我的知识库（根目录）</option>
                {moveTargets.map((target) => (
                  <option value={target.id} key={target.id}>
                    {target.name}
                  </option>
                ))}
              </ProductSelect>
            </ProductField>
            <ProductError error={moveError} />
          </div>
        </form>
      </ProductModal>

      <ProductModal
        open={batchMoveOpen}
        title="批量移动"
        description={`已选择 ${selectedSpaces.length} 个知识库`}
        onClose={() => !batchBusy && setBatchMoveOpen(false)}
        footer={
          <>
            <ProductButton onClick={() => setBatchMoveOpen(false)} disabled={batchBusy}>
              取消
            </ProductButton>
            <ProductButton tone="primary" busy={batchBusy} onClick={() => void runBatch('move')}>
              确认移动
            </ProductButton>
          </>
        }
      >
        <ProductField label="目标位置">
          <ProductSelect
            value={batchTargetId}
            onChange={(event) => setBatchTargetId(event.target.value)}
          >
            <option value="">我的知识库（根目录）</option>
            {allSpaces
              .filter((space) => space.kind === 'folder')
              .filter((folder) => !selectedIds.includes(folder.id))
              .map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.name}
                </option>
              ))}
          </ProductSelect>
        </ProductField>
        <ProductError error={batchError} />
      </ProductModal>

      <ProductModal
        open={batchDeleteOpen}
        title="批量删除"
        description={`将删除 ${selectedSpaces.length} 个知识库`}
        onClose={() => !batchBusy && setBatchDeleteOpen(false)}
        footer={
          <>
            <ProductButton onClick={() => setBatchDeleteOpen(false)} disabled={batchBusy}>
              取消
            </ProductButton>
            <ProductButton
              tone="danger"
              busy={batchBusy}
              disabled={batchDeleteText !== batchDeleteConfirmation}
              onClick={() => void runBatch('delete')}
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
            autoComplete="off"
          />
        </ProductField>
        <ProductError error={batchError} />
      </ProductModal>

      <PermissionDialog target={permissionTarget} onClose={() => setPermissionTarget(null)} />

      <ProductModal
        open={Boolean(dragConfirm)}
        title="确认移动"
        description="移动后，资源将继承目标文件夹的访问权限。"
        onClose={() => !moveBusy && setDragConfirm(null)}
        footer={
          <>
            <ProductButton onClick={() => setDragConfirm(null)} disabled={moveBusy}>
              取消
            </ProductButton>
            <ProductButton tone="primary" busy={moveBusy} onClick={() => void confirmDragMove()}>
              确认移动
            </ProductButton>
          </>
        }
      >
        <p>
          将 <strong>{dragConfirm?.source.name}</strong> 移动到{' '}
          <strong>{dragConfirm?.target.name}</strong>。
        </p>
      </ProductModal>
    </ProductAppShell>
  );
}

function PermissionDialog(props: { target: KnowledgeSpace | null; onClose: () => void }) {
  const toast = useProductToast();
  const queryClient = useQueryClient();
  const [memberId, setMemberId] = useState('');
  const [role, setRole] = useState<'read' | 'write' | 'manage'>('read');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferMemberId, setTransferMemberId] = useState('');
  const session = useQuery({
    queryKey: ['kb-product', 'session'],
    queryFn: productSession,
    enabled: Boolean(props.target),
  });
  const currentSpace = useQuery({
    queryKey: ['kb-product', 'space', props.target?.id],
    queryFn: () => productApi.getSpace(props.target!.id),
    enabled: Boolean(props.target),
  });
  const collaborators = useQuery({
    queryKey: ['kb-product', 'collaborators', props.target?.id],
    queryFn: () => listCollaborators(props.target!.id),
    enabled: Boolean(props.target),
  });
  const acl = useQuery<Acl>({
    queryKey: ['kb-product', 'acl', 'space', props.target?.id],
    queryFn: () => getAcl('space', props.target!.id),
    enabled: Boolean(props.target),
  });

  useEffect(() => {
    setMemberId('');
    setRole('read');
    setError(null);
    setTransferOpen(false);
    setTransferMemberId('');
  }, [props.target]);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!props.target || !memberId.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await addCollaborator(props.target.id, { memberId: memberId.trim(), role });
      await Promise.all([
        collaborators.refetch(),
        acl.refetch(),
        currentSpace.refetch(),
        queryClient.invalidateQueries({ queryKey: ['kb-product', 'spaces'] }),
      ]);
      setMemberId('');
      toast.success('协作者已添加');
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (item: Collaborator) => {
    if (!props.target) return;
    setBusy(true);
    setError(null);
    try {
      await removeCollaborator(props.target.id, item);
      await Promise.all([collaborators.refetch(), acl.refetch()]);
      toast.success('协作者已移除');
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const transfer = async () => {
    if (!props.target || !transferMemberId || !currentSpace.data) return;
    setBusy(true);
    setError(null);
    try {
      await productApi.transferSpaceOwnership(
        props.target.id,
        transferMemberId,
        currentSpace.data.version,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['kb-product', 'spaces'] }),
        queryClient.invalidateQueries({ queryKey: ['kb-product', 'space', props.target.id] }),
        queryClient.invalidateQueries({
          queryKey: ['kb-product', 'collaborators', props.target.id],
        }),
        queryClient.invalidateQueries({
          queryKey: ['kb-product', 'acl', 'space', props.target.id],
        }),
      ]);
      toast.success('所有权已转移');
      props.onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const ownerId = currentSpace.data?.ownershipMemberId ?? props.target?.ownershipMemberId;
  const canTransfer =
    Boolean(session.data) && (session.data!.isWorkspaceOwner || session.data!.memberId === ownerId);
  const transferCandidates = (collaborators.data?.items ?? []).filter(
    (item) => item.status === 'active' && item.role === 'manage' && item.memberId !== ownerId,
  );

  return (
    <ProductModal
      open={Boolean(props.target)}
      title="权限配置"
      description={props.target?.name}
      onClose={() => !busy && props.onClose()}
    >
      <ProductError error={error ?? collaborators.error ?? acl.error} />
      <div className="kb2-note">
        ACL 状态：
        {acl.data
          ? `${acl.data.permissionState} / ${acl.data.inheritMode}，权限版本 ${acl.data.permissionRevision}`
          : '正在读取'}
      </div>
      <div className="kb2-divider" />
      <form className="kb2-permission-add" onSubmit={add}>
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
            onChange={(event) => setRole(event.target.value as typeof role)}
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
      <div className="kb2-permission-list">
        <h3>协作者</h3>
        {collaborators.isLoading ? (
          <div className="kb2-center-state">
            <Spinner size="sm" /> 正在读取协作者
          </div>
        ) : (collaborators.data?.items ?? []).filter((item) => item.status === 'active').length ===
          0 ? (
          <div className="kb2-center-state">暂时没有独立协作者</div>
        ) : (
          (collaborators.data?.items ?? [])
            .filter((item) => item.status === 'active')
            .map((item) => (
              <div className="kb2-permission-row" key={item.memberId}>
                <span>
                  <strong>{item.memberId}</strong>
                  <small>授予于 {formatDate(item.grantedAt)}</small>
                </span>
                <StatusTag value={item.role} tone={item.role === 'owner' ? 'purple' : 'info'} />
                <ProductIconButton
                  label={`移除协作者 ${item.memberId}`}
                  tone="danger"
                  onClick={() => void remove(item)}
                >
                  <DeleteIcon boxSize={3.5} />
                </ProductIconButton>
              </div>
            ))
        )}
      </div>
      {canTransfer ? (
        <div className="kb2-permission-transfer">
          <ProductButton
            tone="danger"
            aria-expanded={transferOpen}
            onClick={() => setTransferOpen((value) => !value)}
          >
            转移所有权
          </ProductButton>
          {transferOpen ? (
            <div className="kb2-form-grid">
              <ProductField label="新所有者">
                <ProductSelect
                  value={transferMemberId}
                  onChange={(event) => setTransferMemberId(event.target.value)}
                  disabled={transferCandidates.length === 0}
                >
                  <option value="">
                    {transferCandidates.length === 0 ? '暂无满足条件的协作者' : '选择可管理协作者'}
                  </option>
                  {transferCandidates.map((item) => (
                    <option key={item.memberId} value={item.memberId}>
                      {item.memberId}
                    </option>
                  ))}
                </ProductSelect>
              </ProductField>
              <p className="kb2-table-muted">转移后您的 Owner 权限不会保留。</p>
              <ProductButton
                tone="danger"
                busy={busy}
                disabled={!transferMemberId}
                onClick={() => void transfer()}
              >
                确认转移所有权
              </ProductButton>
            </div>
          ) : null}
        </div>
      ) : null}
    </ProductModal>
  );
}
