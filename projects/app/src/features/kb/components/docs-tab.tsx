import { useCallback, useEffect, useMemo, useState } from 'react';
import { kbApi } from '../lib/kb-api';
import { collectionTypeLabel, formatDateTime, modeLabel } from '../lib/format';
import { useKbResource } from '../lib/use-kb-resource';
import type { CollectionSummary, CreateCollectionResult, TagItem } from '../types';
import styles from '../styles/kb.module.css';
import {
  Badge,
  Button,
  ConfirmDialog,
  Drawer,
  EmptyState,
  Icon,
  InlineError,
  Input,
  Select,
  Spinner,
  StatusBadge,
} from './ui';
import { CollectionCreateDrawer, CollectionImportDrawer } from './collection-create-drawer';
import { DeleteJobDrawer } from './delete-job-drawer';

const PAGE_SIZE = 20;

export function DocsTab({
  datasetId,
  datasetName,
  page,
  onPageChange,
  onOpenData,
  onChanged,
  onNotify,
}: {
  datasetId: string;
  datasetName: string;
  page: number;
  onPageChange: (page: number) => void;
  onOpenData: (collectionId: string) => void;
  onChanged: () => void;
  onNotify: (message: string) => void;
}) {
  const [filter, setFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [detail, setDetail] = useState<CollectionSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CollectionSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<unknown>(null);
  const [jobId, setJobId] = useState('');
  const [tagTarget, setTagTarget] = useState<CollectionSummary | null>(null);
  const [moveTarget, setMoveTarget] = useState<CollectionSummary | null>(null);
  const [live, setLive] = useState<Record<string, string>>({});

  const resource = useKbResource(`${datasetId}:${page}`, () =>
    kbApi.listCollections({ datasetId, page, limit: PAGE_SIZE }),
  );
  const tags = useKbResource(`${datasetId}:tags`, () => kbApi.listTags(datasetId));
  const { reload } = resource;

  const tagMap = useMemo(() => {
    const map = new Map<string, TagItem>();
    for (const tag of tags.data?.list ?? []) map.set(tag.tagId, tag);
    return map;
  }, [tags.data]);

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (resource.data?.list ?? []).filter((row) => {
      if (typeFilter && row.type !== typeFilter) return false;
      if (!needle) return true;
      return row.name.toLowerCase().includes(needle);
    });
  }, [filter, resource.data, typeFilter]);

  const pendingKey = useMemo(() => {
    return (resource.data?.list ?? [])
      .filter((row) => {
        const state = live[row.collectionId] ?? row.trainingState;
        return state === 'running' || state === 'queued';
      })
      .map((row) => row.collectionId)
      .join(',');
  }, [live, resource.data]);

  useEffect(() => {
    if (!pendingKey) return;
    const ids = pendingKey.split(',');
    const timer = window.setInterval(() => {
      void Promise.all(
        ids.map(async (id) => {
          try {
            const next = await kbApi.collectionTrainingStatus(id);
            setLive((previous) => ({
              ...previous,
              [id]: next.trainingState ?? 'unknown',
            }));
            if (next.trainingState === 'ready' || next.trainingState === 'error') {
              reload();
            }
          } catch {
            // 轮询失败不改变当前状态，下一次继续。
          }
        }),
      );
    }, 3000);
    return () => window.clearInterval(timer);
  }, [pendingKey, reload]);

  const total = resource.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasFilters = filter.trim().length > 0 || typeFilter !== '';
  const folders = (resource.data?.list ?? []).filter((item) => item.type === 'folder');

  const requestDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const job = await kbApi.deleteCollection(deleteTarget.collectionId);
      if (job.jobId) setJobId(job.jobId);
      setDeleteTarget(null);
      setDetail(null);
      onNotify('已提交集合删除');
      reload();
    } catch (caught) {
      setDeleteError(caught);
    } finally {
      setDeleting(false);
    }
  };

  const onDeleteFinished = useCallback(() => {
    reload();
    onChanged();
  }, [onChanged, reload]);

  return (
    <div>
      <div className={styles.panel}>
        <div className={styles.toolbar}>
          <div className={styles.toolbarGroup}>
            <div className={styles.searchBox}>
              <Icon name="search" size={14} />
              <Input
                aria-label="在当前页筛选集合"
                placeholder="在当前页筛选名称"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
            </div>
            <Select
              aria-label="集合类型"
              value={typeFilter}
              onChange={(event) => setTypeFilter(event.target.value)}
            >
              <option value="">全部类型</option>
              <option value="file">文件</option>
              <option value="folder">文件夹</option>
              <option value="link">链接</option>
              <option value="virtual">空集合</option>
              <option value="images">图片</option>
            </Select>
            <span className={styles.muted}>当前页筛选</span>
          </div>
          <div className={styles.toolbarSpacer} />
          <div className={styles.toolbarGroup}>
            <Button icon="refresh" onClick={reload} loading={resource.loading}>
              刷新
            </Button>
            <Button icon="upload" onClick={() => setImportOpen(true)}>
              导入数据
            </Button>
            <Button variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>
              新建集合
            </Button>
          </div>
        </div>

        {resource.error ? (
          <div className={styles.section}>
            <InlineError error={resource.error} onRetry={reload} />
          </div>
        ) : null}
        {resource.loading && !resource.data ? <Spinner label="加载集合" /> : null}
        {resource.data && rows.length === 0 ? (
          <EmptyState
            title={hasFilters ? '当前筛选没有集合' : '还没有集合'}
            hint={hasFilters ? '清除筛选后再试。' : '导入一段文本，或新建文件夹、链接、空集合。'}
            action={
              hasFilters ? (
                <Button
                  onClick={() => {
                    setFilter('');
                    setTypeFilter('');
                  }}
                >
                  清除筛选
                </Button>
              ) : (
                <Button variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>
                  新建集合
                </Button>
              )
            }
          />
        ) : null}
        {rows.length > 0 ? (
          <>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>类型</th>
                    <th>训练状态</th>
                    <th>训练模式</th>
                    <th>更新时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const state = live[row.collectionId] ?? row.trainingState;
                    return (
                      <tr
                        key={row.collectionId}
                        className={styles.clickableRow}
                        onClick={() => setDetail(row)}
                      >
                        <td data-label="名称">
                          <div>{row.name}</div>
                          {row.tagIds.length > 0 ? (
                            <div className={styles.chips}>
                              {row.tagIds.map((tagId) => (
                                <span key={tagId} className={styles.tagChip}>
                                  {tagMap.get(tagId)?.name ?? tagId.slice(-6)}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </td>
                        <td data-label="类型">
                          <Badge tone={row.type === 'folder' ? 'muted' : 'info'}>
                            {collectionTypeLabel(row.type)}
                          </Badge>
                        </td>
                        <td data-label="训练状态">
                          <StatusBadge state={state} />
                          {row.remainingTraining ? (
                            <span className={styles.muted}> 剩余 {row.remainingTraining}</span>
                          ) : null}
                        </td>
                        <td data-label="训练模式">{modeLabel(row.trainingMode)}</td>
                        <td data-label="更新时间">{formatDateTime(row.updateTime)}</td>
                        <td data-label="操作">
                          <div
                            className={styles.rowActions}
                            onClick={(event) => event.stopPropagation()}
                          >
                            <Button size="sm" onClick={() => onOpenData(row.collectionId)}>
                              数据
                            </Button>
                            <Button size="sm" onClick={() => setTagTarget(row)}>
                              标签
                            </Button>
                            <Button size="sm" onClick={() => setMoveTarget(row)}>
                              移动
                            </Button>
                            <Button
                              size="sm"
                              disabled
                              title="后端暂未接入：TenantQuotaProvider 501999"
                            >
                              重训
                            </Button>
                            <Button size="sm" variant="danger" onClick={() => setDeleteTarget(row)}>
                              删除
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className={styles.pager}>
              <span className={styles.pagerInfo}>
                第 {page} / {totalPages} 页 · 共 {total} 个
              </span>
              <div className={styles.pagerButtons}>
                <Button
                  size="sm"
                  icon="left"
                  disabled={page <= 1}
                  onClick={() => onPageChange(page - 1)}
                >
                  上一页
                </Button>
                <Button
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => onPageChange(page + 1)}
                >
                  下一页
                  <Icon name="right" size={14} />
                </Button>
              </div>
            </div>
          </>
        ) : null}
      </div>

      {createOpen ? (
        <CollectionCreateDrawer
          datasetId={datasetId}
          onClose={() => setCreateOpen(false)}
          onCreated={(created: CreateCollectionResult, message: string) => {
            setLive((previous) => ({ ...previous, [created.collectionId]: 'running' }));
            onNotify(message);
            reload();
            onChanged();
          }}
        />
      ) : null}
      {importOpen ? (
        <CollectionImportDrawer
          datasetId={datasetId}
          collections={(resource.data?.list ?? []).map((item) => ({
            collectionId: item.collectionId,
            name: item.name,
          }))}
          defaultCollectionId={undefined}
          onClose={() => setImportOpen(false)}
          onImported={(message) => {
            onNotify(message);
            reload();
            onChanged();
          }}
        />
      ) : null}
      {detail ? (
        <CollectionDetailDrawer
          collection={detail}
          tags={tagMap}
          onClose={() => setDetail(null)}
          onOpenData={() => {
            onOpenData(detail.collectionId);
            setDetail(null);
          }}
          onExport={async () => {
            try {
              await kbApi.exportCollection(detail.collectionId, detail.name);
              onNotify('导出已开始');
            } catch (caught) {
              setDeleteError(caught);
            }
          }}
          onDelete={() => {
            setDeleteTarget(detail);
            setDetail(null);
          }}
          onSync={
            ['link', 'apiFile', 'externalFile'].includes(detail.type)
              ? async () => {
                  try {
                    await kbApi.syncCollection(detail.collectionId);
                    onNotify('同步任务已入队');
                    reload();
                  } catch (caught) {
                    setDeleteError(caught);
                  }
                }
              : undefined
          }
        />
      ) : null}
      {tagTarget ? (
        <CollectionTagDrawer
          datasetId={datasetId}
          collection={tagTarget}
          tags={tags.data?.list ?? []}
          onClose={() => setTagTarget(null)}
          onSaved={() => {
            onNotify('标签已更新');
            tags.reload();
            reload();
          }}
        />
      ) : null}
      {moveTarget ? (
        <CollectionMoveDialog
          collection={moveTarget}
          folders={folders.filter((folder) => folder.collectionId !== moveTarget.collectionId)}
          onClose={() => setMoveTarget(null)}
          onMoved={() => {
            onNotify('集合已移动');
            reload();
          }}
        />
      ) : null}
      {deleteError ? <InlineError error={deleteError} /> : null}
      {deleteTarget ? (
        <ConfirmDialog
          title="删除集合"
          target={deleteTarget.name}
          impact="将提交异步删除任务；集合下的数据与索引会被清理。此操作不可撤销。"
          confirmLabel="确认删除"
          busy={deleting}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void requestDelete()}
        />
      ) : null}
      {jobId ? (
        <DeleteJobDrawer jobId={jobId} onClose={() => setJobId('')} onFinished={onDeleteFinished} />
      ) : null}
      {resource.loading && resource.data ? (
        <span className={styles.srOnly}>正在刷新集合</span>
      ) : null}
      <span className={styles.srOnly}>数据集 {datasetName}</span>
    </div>
  );
}

function CollectionDetailDrawer({
  collection,
  tags,
  onClose,
  onOpenData,
  onExport,
  onDelete,
  onSync,
}: {
  collection: CollectionSummary;
  tags: Map<string, TagItem>;
  onClose: () => void;
  onOpenData: () => void;
  onExport: () => void;
  onDelete: () => void;
  onSync?: () => void;
}) {
  return (
    <Drawer
      title="集合详情"
      onClose={onClose}
      footer={
        <>
          {onSync ? <Button onClick={onSync}>同步</Button> : null}
          <Button icon="download" onClick={onExport}>
            导出
          </Button>
          <Button variant="primary" onClick={onOpenData}>
            查看数据
          </Button>
          <Button variant="danger" onClick={onDelete}>
            删除
          </Button>
        </>
      }
    >
      <div className={styles.stack}>
        <div>
          <span className={styles.muted}>名称</span>
          <div>{collection.name}</div>
        </div>
        <div className={styles.inline}>
          <Badge tone="info">{collectionTypeLabel(collection.type)}</Badge>
          <StatusBadge state={collection.trainingState} />
          <span className={styles.muted}>模式 {modeLabel(collection.trainingMode)}</span>
        </div>
        <div>
          <span className={styles.muted}>更新时间</span>
          <div>{formatDateTime(collection.updateTime)}</div>
        </div>
        <div>
          <span className={styles.muted}>标签</span>
          <div className={styles.chips}>
            {collection.tagIds.length > 0
              ? collection.tagIds.map((tagId) => (
                  <span key={tagId} className={styles.tagChip}>
                    {tags.get(tagId)?.name ?? tagId.slice(-6)}
                  </span>
                ))
              : '无'}
          </div>
        </div>
        <details className={styles.diagnostics}>
          <summary>诊断信息</summary>
          <pre>{JSON.stringify({ sourceRef: collection.sourceRef }, null, 2)}</pre>
        </details>
      </div>
    </Drawer>
  );
}

function CollectionTagDrawer({
  datasetId,
  collection,
  tags,
  onClose,
  onSaved,
}: {
  datasetId: string;
  collection: CollectionSummary;
  tags: TagItem[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [list, setList] = useState(tags);
  const [selected, setSelected] = useState<string[]>(collection.tagIds);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await kbApi.updateCollection({
        collectionId: collection.collectionId,
        version: collection.version,
        tagIds: selected,
      });
      onSaved();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await kbApi.createTag(datasetId, newName.trim());
      setList((previous) => [...previous, created]);
      setSelected((previous) => [...previous, created.tagId]);
      setNewName('');
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      title="集合标签"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void save()} loading={busy}>
            保存
          </Button>
        </>
      }
    >
      {error ? <InlineError error={error} /> : null}
      <div className={styles.chips}>
        {list.length > 0 ? (
          list.map((tag) => (
            <button
              key={tag.tagId}
              type="button"
              className={`${styles.tagChipButton} ${
                selected.includes(tag.tagId) ? styles.tagChipButtonActive : ''
              }`}
              onClick={() =>
                setSelected((previous) =>
                  previous.includes(tag.tagId)
                    ? previous.filter((id) => id !== tag.tagId)
                    : [...previous, tag.tagId],
                )
              }
            >
              {tag.name}
            </button>
          ))
        ) : (
          <span className={styles.muted}>还没有标签</span>
        )}
      </div>
      <div className={styles.divider} />
      <div className={styles.inline}>
        <Input
          value={newName}
          placeholder="新标签名称"
          onChange={(event) => setNewName(event.target.value)}
        />
        <Button onClick={() => void create()} disabled={!newName.trim() || busy}>
          新建标签
        </Button>
      </div>
    </Drawer>
  );
}

function CollectionMoveDialog({
  collection,
  folders,
  onClose,
  onMoved,
}: {
  collection: CollectionSummary;
  folders: CollectionSummary[];
  onClose: () => void;
  onMoved: () => void;
}) {
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const move = async () => {
    setBusy(true);
    setError(null);
    try {
      await kbApi.moveCollection({
        collectionId: collection.collectionId,
        targetParentId: target || null,
        version: collection.version,
      });
      onMoved();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      title="移动集合"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void move()} loading={busy}>
            移动
          </Button>
        </>
      }
    >
      {error ? <InlineError error={error} /> : null}
      <p className={styles.muted}>
        将 <strong>{collection.name}</strong> 移动到：
      </p>
      <Select value={target} onChange={(event) => setTarget(event.target.value)}>
        <option value="">根目录</option>
        {folders.map((folder) => (
          <option key={folder.collectionId} value={folder.collectionId}>
            {folder.name}
          </option>
        ))}
      </Select>
    </Drawer>
  );
}
