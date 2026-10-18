import { useEffect, useState } from 'react';
import { kbApi, uploadFile } from '../lib/kb-api';
import { collectionTypeLabel, formatDateTime } from '../lib/format';
import { useKbResource } from '../lib/use-kb-resource';
import { KbValidationError } from '../lib/validation';
import type { DataDetailData, DataItem } from '../types';
import styles from '../styles/kb.module.css';
import {
  Badge,
  Button,
  ConfirmDialog,
  Drawer,
  EmptyState,
  Field,
  Icon,
  InlineError,
  Input,
  Select,
  Spinner,
  Textarea,
} from './ui';

const PAGE_SIZE = 20;

export function DataTab({
  datasetId,
  collectionId,
  openDataId,
  page,
  onPageChange,
  onCollectionChange,
  onOpenDataConsumed,
  onChanged,
  onNotify,
}: {
  datasetId: string;
  collectionId: string;
  openDataId: string;
  page: number;
  onPageChange: (page: number) => void;
  onCollectionChange: (collectionId: string) => void;
  onOpenDataConsumed: () => void;
  onChanged: () => void;
  onNotify: (message: string) => void;
}) {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [detailId, setDetailId] = useState('');
  const [editId, setEditId] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<DataItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<unknown>(null);
  const [insertOpen, setInsertOpen] = useState(false);
  const [pushOpen, setPushOpen] = useState(false);
  const [imageOpen, setImageOpen] = useState(false);

  const collections = useKbResource(datasetId, () =>
    kbApi.listCollections({ datasetId, page: 1, limit: 100 }),
  );
  const list = collections.data?.list ?? [];
  const selected = list.find((item) => item.collectionId === collectionId) ?? null;

  useEffect(() => {
    if (!collectionId && list.length > 0) {
      onCollectionChange(list[0]?.collectionId ?? '');
    }
  }, [collectionId, list, onCollectionChange]);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 350);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    if (openDataId) {
      setDetailId(openDataId);
      onOpenDataConsumed();
    }
  }, [onOpenDataConsumed, openDataId]);

  const data = useKbResource(`${collectionId}:${page}:${search}`, () =>
    collectionId
      ? kbApi.listData({
          collectionId,
          page,
          limit: PAGE_SIZE,
          ...(search ? { search } : {}),
        })
      : Promise.resolve({ total: 0, list: [] }),
  );

  const total = data.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const isImages = selected?.type === 'images';

  const remove = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await kbApi.deleteData(deleteTarget.dataId);
      onNotify('数据已删除');
      setDeleteTarget(null);
      setDetailId('');
      data.reload();
      onChanged();
    } catch (caught) {
      setDeleteError(caught);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div>
      <div className={styles.panel}>
        <div className={styles.toolbar}>
          <div className={styles.toolbarGroup}>
            <Select
              aria-label="选择集合"
              value={collectionId}
              onChange={(event) => {
                onCollectionChange(event.target.value);
                onPageChange(1);
              }}
              className={styles.collectionSelect}
            >
              <option value="">选择集合</option>
              {list.map((item) => (
                <option key={item.collectionId} value={item.collectionId}>
                  {item.name} · {collectionTypeLabel(item.type)}
                </option>
              ))}
            </Select>
            {selected ? <Badge tone="info">{collectionTypeLabel(selected.type)}</Badge> : null}
            <div className={styles.searchBox}>
              <Icon name="search" size={14} />
              <Input
                aria-label="搜索数据"
                placeholder="搜索问题或答案"
                value={searchInput}
                onChange={(event) => {
                  setSearchInput(event.target.value);
                  onPageChange(1);
                }}
              />
            </div>
          </div>
          <div className={styles.toolbarSpacer} />
          <div className={styles.toolbarGroup}>
            <Button icon="refresh" onClick={data.reload} loading={data.loading}>
              刷新
            </Button>
            <Button icon="plus" onClick={() => setInsertOpen(true)} disabled={!collectionId}>
              插入数据
            </Button>
            <Button onClick={() => setPushOpen(true)} disabled={!collectionId}>
              批量推送
            </Button>
            {isImages ? (
              <Button icon="upload" onClick={() => setImageOpen(true)}>
                追加图片
              </Button>
            ) : null}
          </div>
        </div>

        {collections.error ? (
          <div className={styles.section}>
            <InlineError error={collections.error} onRetry={collections.reload} />
          </div>
        ) : null}
        {!collectionId && collections.data ? (
          <EmptyState title="还没有可查看的集合" hint="先在文档标签中导入文本或创建空集合。" />
        ) : null}
        {collectionId && data.error ? (
          <div className={styles.section}>
            <InlineError error={data.error} onRetry={data.reload} />
          </div>
        ) : null}
        {collectionId && data.loading && !data.data ? <Spinner label="加载数据" /> : null}
        {collectionId && data.data && (data.data.list ?? []).length === 0 ? (
          <EmptyState
            title={search ? '没有匹配的数据' : '这个集合还没有数据'}
            hint={search ? '尝试清空搜索词。' : '训练完成后会出现数据；也可以直接插入一条问答。'}
            action={
              search ? (
                <Button
                  onClick={() => {
                    setSearchInput('');
                    setSearch('');
                  }}
                >
                  清空搜索
                </Button>
              ) : (
                <Button variant="primary" onClick={() => setInsertOpen(true)}>
                  插入数据
                </Button>
              )
            }
          />
        ) : null}
        {collectionId && (data.data?.list ?? []).length > 0 ? (
          <>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>问题</th>
                    <th>答案</th>
                    <th>更新时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {data.data?.list.map((item) => (
                    <tr
                      key={item.dataId}
                      className={styles.clickableRow}
                      onClick={() => setDetailId(item.dataId)}
                    >
                      <td data-label="问题">
                        <div className={styles.clamp2}>{item.q || '—'}</div>
                      </td>
                      <td data-label="答案">
                        <div className={styles.clamp2}>{item.a || '—'}</div>
                      </td>
                      <td data-label="更新时间">{formatDateTime(item.updateTime)}</td>
                      <td data-label="操作">
                        <div
                          className={styles.rowActions}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <Button size="sm" onClick={() => setEditId(item.dataId)}>
                            编辑
                          </Button>
                          <Button size="sm" variant="danger" onClick={() => setDeleteTarget(item)}>
                            删除
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className={styles.pager}>
              <span className={styles.pagerInfo}>
                第 {page} / {totalPages} 页 · 共 {total} 条
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

      {detailId ? (
        <DataDetailDrawer
          dataId={detailId}
          onClose={() => setDetailId('')}
          onEdit={() => {
            setEditId(detailId);
            setDetailId('');
          }}
          onDelete={(item) => {
            setDeleteTarget(item);
            setDetailId('');
          }}
        />
      ) : null}
      {editId ? (
        <DataEditDrawer
          dataId={editId}
          onClose={() => setEditId('')}
          onSaved={() => {
            onNotify('数据已更新');
            data.reload();
          }}
        />
      ) : null}
      {insertOpen && collectionId ? (
        <DataInsertDrawer
          collectionId={collectionId}
          onClose={() => setInsertOpen(false)}
          onSaved={() => {
            onNotify('已插入数据');
            data.reload();
            onChanged();
          }}
        />
      ) : null}
      {pushOpen && collectionId ? (
        <DataPushDrawer
          collectionId={collectionId}
          onClose={() => setPushOpen(false)}
          onPushed={(accepted) => {
            onNotify(`已入队 ${accepted} 条数据`);
            window.setTimeout(() => {
              data.reload();
              onChanged();
            }, 1500);
          }}
        />
      ) : null}
      {imageOpen && collectionId ? (
        <ImageAppendDrawer
          datasetId={datasetId}
          collectionId={collectionId}
          onClose={() => setImageOpen(false)}
          onSaved={() => {
            onNotify('图片已追加');
            data.reload();
            onChanged();
          }}
        />
      ) : null}
      {deleteError ? <InlineError error={deleteError} /> : null}
      {deleteTarget ? (
        <ConfirmDialog
          title="删除数据"
          target={deleteTarget.q || deleteTarget.dataId}
          impact="删除后将从集合中移除该条数据及其索引；此操作不可撤销。"
          confirmLabel="确认删除"
          busy={deleting}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void remove()}
        />
      ) : null}
    </div>
  );
}

function DataDetailDrawer({
  dataId,
  onClose,
  onEdit,
  onDelete,
}: {
  dataId: string;
  onClose: () => void;
  onEdit: () => void;
  onDelete: (item: DataItem) => void;
}) {
  const resource = useKbResource(dataId, () => kbApi.getData(dataId));
  const detail: DataDetailData | null = resource.data;
  return (
    <Drawer
      title="数据详情"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>关闭</Button>
          <Button onClick={onEdit} disabled={!detail}>
            编辑
          </Button>
          <Button
            variant="danger"
            disabled={!detail}
            onClick={() => detail && onDelete(detail.data)}
          >
            删除
          </Button>
        </>
      }
    >
      {resource.loading ? <Spinner label="加载数据详情" /> : null}
      {resource.error ? <InlineError error={resource.error} onRetry={resource.reload} /> : null}
      {detail ? (
        <div className={styles.stack}>
          <div>
            <div className={styles.muted}>问题</div>
            <div className={styles.preWrap}>{detail.data.q || '—'}</div>
          </div>
          <div>
            <div className={styles.muted}>答案</div>
            <div className={styles.preWrap}>{detail.data.a || '—'}</div>
          </div>
          <div className={styles.inline}>
            <span className={styles.muted}>更新时间 {formatDateTime(detail.data.updateTime)}</span>
            <span className={styles.muted}>版本 {detail.data.version}</span>
          </div>
          <details className={styles.diagnostics}>
            <summary>元数据与索引</summary>
            <pre>
              {JSON.stringify({ metadata: detail.metadata, indexes: detail.indexes }, null, 2)}
            </pre>
          </details>
        </div>
      ) : null}
    </Drawer>
  );
}

function DataEditDrawer({
  dataId,
  onClose,
  onSaved,
}: {
  dataId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const resource = useKbResource(dataId, () => kbApi.getData(dataId));
  const [q, setQ] = useState('');
  const [a, setA] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (resource.data && !ready) {
      setQ(resource.data.data.q ?? '');
      setA(resource.data.data.a ?? '');
      setReady(true);
    }
  }, [ready, resource.data]);

  const save = async () => {
    const version = resource.data?.data.version;
    if (!version || !q.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await kbApi.updateData({ dataId, version, q: q.trim(), a });
      onSaved();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      title="编辑数据"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            variant="primary"
            onClick={() => void save()}
            loading={busy}
            disabled={!ready || !q.trim()}
          >
            保存
          </Button>
        </>
      }
    >
      {resource.loading ? <Spinner label="读取数据" /> : null}
      {resource.error ? <InlineError error={resource.error} onRetry={resource.reload} /> : null}
      {error ? <InlineError error={error} /> : null}
      <Field label="问题" required>
        <Textarea value={q} onChange={(event) => setQ(event.target.value)} />
      </Field>
      <Field label="答案">
        <Textarea value={a} onChange={(event) => setA(event.target.value)} />
      </Field>
    </Drawer>
  );
}

function DataInsertDrawer({
  collectionId,
  onClose,
  onSaved,
}: {
  collectionId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [q, setQ] = useState('');
  const [a, setA] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const save = async () => {
    if (!q.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await kbApi.insertData({ collectionId, q: q.trim(), ...(a ? { a } : {}) });
      onSaved();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer
      title="插入数据"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void save()} loading={busy} disabled={!q.trim()}>
            插入
          </Button>
        </>
      }
    >
      {error ? <InlineError error={error} /> : null}
      <Field label="问题" required hint="直接插入不经过 Parser 或训练队列。">
        <Textarea autoFocus value={q} onChange={(event) => setQ(event.target.value)} />
      </Field>
      <Field label="答案">
        <Textarea value={a} onChange={(event) => setA(event.target.value)} />
      </Field>
    </Drawer>
  );
}

function parsePushInput(raw: string): { q: string; a?: string }[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) throw new KbValidationError('JSON 必须是数组');
    return parsed.map((item, index) => {
      if (!item || typeof item !== 'object') {
        throw new KbValidationError(`第 ${index + 1} 项不是对象`);
      }
      const record = item as Record<string, unknown>;
      if (typeof record.q !== 'string' || !record.q.trim()) {
        throw new KbValidationError(`第 ${index + 1} 项缺少 q`);
      }
      return {
        q: record.q.trim(),
        ...(typeof record.a === 'string' && record.a ? { a: record.a } : {}),
      };
    });
  }
  return trimmed.split('\n').map((line, index) => {
    const [q, ...rest] = line.split(/[|\t]/);
    if (!q?.trim()) throw new KbValidationError(`第 ${index + 1} 行缺少问题`);
    const answer = rest.join('|').trim();
    return { q: q.trim(), ...(answer ? { a: answer } : {}) };
  });
}

function DataPushDrawer({
  collectionId,
  onClose,
  onPushed,
}: {
  collectionId: string;
  onClose: () => void;
  onPushed: (accepted: number) => void;
}) {
  const [raw, setRaw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>('');
  const [apiError, setApiError] = useState<unknown>(null);

  const submit = async () => {
    setError('');
    setApiError(null);
    let items: { q: string; a?: string }[];
    try {
      items = parsePushInput(raw);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '格式错误');
      return;
    }
    if (items.length === 0) {
      setError('至少输入一条数据');
      return;
    }
    if (items.length > 200) {
      setError('单次最多 200 条');
      return;
    }
    if (new Blob([JSON.stringify(items)]).size > 10 * 1024 * 1024) {
      setError('请求体超过 10MB');
      return;
    }
    setBusy(true);
    try {
      const result = await kbApi.pushData(collectionId, items);
      onPushed(result.queued.accepted);
      onClose();
    } catch (caught) {
      setApiError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      title="批量推送"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy}>
            推送
          </Button>
        </>
      }
    >
      {apiError ? <InlineError error={apiError} /> : null}
      {error ? <InlineError error={new KbValidationError(error)} /> : null}
      <Field
        label="数据"
        required
        hint="每行一条，格式 q|a；或粘贴 JSON 数组 [{q,a}]。最多 200 条 / 10MB。"
      >
        <Textarea
          autoFocus
          value={raw}
          className={styles.monoArea}
          onChange={(event) => setRaw(event.target.value)}
          placeholder={'问题一|答案一\n问题二|答案二'}
        />
      </Field>
    </Drawer>
  );
}

function ImageAppendDrawer({
  datasetId,
  collectionId,
  onClose,
  onSaved,
}: {
  datasetId: string;
  collectionId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [error, setError] = useState<unknown>(null);

  const submit = async () => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      setError(new Error('文件超过 10MB'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const uploaded = await uploadFile(datasetId, file, setStage);
      const result = await kbApi.insertImages(collectionId, [uploaded.fileRef]);
      const failed = result.items.find((item) => item.state !== 'success');
      if (failed) throw new KbValidationError(failed.errorMsg ?? '图片处理失败');
      onSaved();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
      setStage('');
    }
  };

  return (
    <Drawer
      title="追加图片"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={!file}>
            {stage || '上传并追加'}
          </Button>
        </>
      }
    >
      {error ? <InlineError error={error} /> : null}
      <Field label="图片" required hint="支持 PNG/JPEG/WebP/GIF，单个文件不超过 10MB。">
        <input
          className={styles.fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
      </Field>
    </Drawer>
  );
}
