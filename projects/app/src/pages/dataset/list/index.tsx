import Link from 'next/link';
import { useRouter } from 'next/router';
import { useCallback, useMemo, useState } from 'react';
import { ProductShell } from '../../../features/kb/components/product-shell';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Icon,
  InlineError,
  Input,
  Notice,
  Select,
  Spinner,
} from '../../../features/kb/components/ui';
import { DeleteJobDrawer } from '../../../features/kb/components/delete-job-drawer';
import {
  DatasetCreateDrawer,
  DatasetRenameDrawer,
} from '../../../features/kb/components/dataset-dialogs';
import { kbApi } from '../../../features/kb/lib/kb-api';
import { datasetTypeLabel, formatDateTime } from '../../../features/kb/lib/format';
import { useKbResource } from '../../../features/kb/lib/use-kb-resource';
import type { DatasetSummary } from '../../../features/kb/types';
import styles from '../../../features/kb/styles/kb.module.css';

const PAGE_SIZE = 20;

export default function DatasetListPage() {
  const router = useRouter();
  const page = Math.max(1, Number(router.query.page ?? 1) || 1);
  const type =
    router.query.type === 'dataset' || router.query.type === 'folder' ? router.query.type : '';
  const [filter, setFilter] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<DatasetSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DatasetSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<unknown>(null);
  const [jobId, setJobId] = useState('');
  const [notice, setNotice] = useState('');

  const key = router.isReady ? `${page}:${type}` : 'pending';
  const resource = useKbResource(key, () =>
    kbApi.listDatasets({ page, limit: PAGE_SIZE, ...(type ? { type } : {}) }),
  );
  const { reload } = resource;

  const updateQuery = useCallback(
    (patch: Record<string, string | number | undefined>) => {
      const next = { ...router.query, ...patch };
      for (const [key, value] of Object.entries(next)) {
        if (value === undefined || value === '') delete next[key];
      }
      const basePath = router.asPath.split('?')[0] || router.pathname;
      void router.replace({ pathname: basePath, query: next }, undefined, {
        shallow: true,
        scroll: false,
      });
    },
    [router],
  );

  const rows = useMemo(() => {
    const list = resource.data?.list ?? [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((row) => row.name.toLowerCase().includes(needle));
  }, [filter, resource.data]);

  const total = resource.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasFilters = filter.trim().length > 0 || type !== '';

  const requestDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const job = await kbApi.deleteDataset(deleteTarget.datasetId);
      if (job.jobId) setJobId(job.jobId);
      setNotice(`已提交删除：${deleteTarget.name}`);
      setDeleteTarget(null);
      resource.reload();
    } catch (caught) {
      setDeleteError(caught);
    } finally {
      setDeleting(false);
    }
  };

  const onFinished = useCallback(() => {
    reload();
  }, [reload]);

  return (
    <ProductShell
      title="知识库"
      breadcrumb="团队工作区 / 知识库"
      actions={
        <Button variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>
          新建知识库
        </Button>
      }
    >
      {notice ? <Notice tone="ok">{notice}</Notice> : null}
      <div className={styles.panel}>
        <div className={styles.toolbar}>
          <div className={styles.toolbarGroup}>
            <div className={styles.searchBox}>
              <Icon name="search" size={14} />
              <Input
                aria-label="在当前页筛选知识库"
                placeholder="在当前页筛选名称"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
            </div>
            <Select
              aria-label="按类型筛选"
              value={type}
              onChange={(event) => updateQuery({ type: event.target.value || undefined, page: 1 })}
            >
              <option value="">全部类型</option>
              <option value="dataset">知识库</option>
              <option value="folder">文件夹</option>
            </Select>
            <span className={styles.muted}>当前页筛选</span>
          </div>
          <div className={styles.toolbarSpacer} />
          <div className={styles.toolbarGroup}>
            <span className={styles.muted}>共 {total} 个</span>
            <Button icon="refresh" onClick={resource.reload} loading={resource.loading}>
              刷新
            </Button>
          </div>
        </div>

        {resource.error ? (
          <div className={styles.section}>
            <InlineError error={resource.error} onRetry={resource.reload} />
          </div>
        ) : null}
        {resource.loading && !resource.data ? <Spinner label="加载知识库" /> : null}
        {resource.data && rows.length === 0 ? (
          <EmptyState
            title={hasFilters ? '当前筛选没有匹配项' : '还没有知识库'}
            hint={
              hasFilters
                ? '清除筛选后再试，或新建一个知识库。'
                : '创建知识库后即可导入文本、查看数据并测试检索。'
            }
            action={
              hasFilters ? (
                <Button
                  onClick={() => {
                    setFilter('');
                    updateQuery({ type: undefined, page: 1 });
                  }}
                >
                  清除筛选
                </Button>
              ) : (
                <Button variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>
                  新建知识库
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
                    <th>向量模型</th>
                    <th>更新时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.datasetId}>
                      <td data-label="名称">
                        <Link className={styles.link} href={`/dataset/detail/${row.datasetId}`}>
                          {row.name}
                        </Link>
                      </td>
                      <td data-label="类型">
                        <Badge tone={row.type === 'folder' ? 'muted' : 'info'}>
                          {datasetTypeLabel(row.type)}
                        </Badge>
                      </td>
                      <td data-label="向量模型">
                        <span className={styles.mono}>{row.vectorModel || '—'}</span>
                      </td>
                      <td data-label="更新时间">{formatDateTime(row.updateTime)}</td>
                      <td data-label="操作">
                        <div className={styles.rowActions}>
                          <Link className={styles.link} href={`/dataset/detail/${row.datasetId}`}>
                            打开
                          </Link>
                          <Button size="sm" onClick={() => setRenameTarget(row)}>
                            重命名
                          </Button>
                          <Button size="sm" variant="danger" onClick={() => setDeleteTarget(row)}>
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
                第 {page} / {totalPages} 页 · 共 {total} 个
              </span>
              <div className={styles.pagerButtons}>
                <Button
                  size="sm"
                  icon="left"
                  disabled={page <= 1}
                  onClick={() => updateQuery({ page: page - 1 })}
                >
                  上一页
                </Button>
                <Button
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => updateQuery({ page: page + 1 })}
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
        <DatasetCreateDrawer
          onClose={() => setCreateOpen(false)}
          onCreated={(created) => {
            setNotice(`已创建：${created.name}`);
            resource.reload();
          }}
        />
      ) : null}
      {renameTarget ? (
        <DatasetRenameDrawer
          dataset={renameTarget}
          onClose={() => setRenameTarget(null)}
          onRenamed={() => {
            setNotice('名称已更新');
            resource.reload();
          }}
        />
      ) : null}
      {deleteError ? <InlineError error={deleteError} /> : null}
      {deleteTarget ? (
        <ConfirmDialog
          title="删除知识库"
          target={deleteTarget.name}
          impact="将提交异步删除任务；知识库、集合、数据与索引会被清理。此操作不可撤销。"
          confirmLabel="确认删除"
          busy={deleting}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void requestDelete()}
        />
      ) : null}
      {jobId ? (
        <DeleteJobDrawer jobId={jobId} onClose={() => setJobId('')} onFinished={onFinished} />
      ) : null}
    </ProductShell>
  );
}
