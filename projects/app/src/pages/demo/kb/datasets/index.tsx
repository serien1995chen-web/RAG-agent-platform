import Link from 'next/link';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useState } from 'react';
import { ConfirmDialog, Drawer } from '../../../../demo/kb/components/drawer';
import { DemoShell } from '../../../../demo/kb/components/demo-shell';
import { EmptyState, Field } from '../../../../demo/kb/components/primitives';
import { api, type DatasetSummary } from '../../../../demo/kb/lib/api';
import { rememberId } from '../../../../demo/kb/lib/run-store';
import { useDemoStore } from '../../../../demo/kb/lib/use-demo-store';
import { useOnce } from '../../../../demo/kb/lib/use-once';
import styles from '../../../../demo/kb/styles/demo.module.css';

export default function DemoDatasetsPage() {
  const router = useRouter();
  const { runs } = useDemoStore();
  const [rows, setRows] = useState<DatasetSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [model, setModel] = useState('bge-m3');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DatasetSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [lastJob, setLastJob] = useState<{ datasetId: string; jobId: string; state: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await api.listDatasets({ limit: 50 });
    setLoading(false);
    if (!result.ok) {
      setError(`${result.entry.status} · ${result.entry.messageKey ?? 'unknown'}`);
      setRows([]);
      return;
    }
    setError(null);
    setRows(result.envelope.data?.list ?? []);
    setTotal(result.envelope.data?.total ?? 0);
  }, []);

  useOnce(() => {
    void load();
  });

  useEffect(() => {
    if (router.query.create === '1') setCreateOpen(true);
  }, [router.query.create]);

  const create = async () => {
    if (!name.trim()) return;
    setCreating(true);
    setCreateError(null);
    const result = await api.createDataset({ name: name.trim(), type: 'dataset', embeddingModel: model });
    setCreating(false);
    if (!result.ok) {
      setCreateError(
        `${result.entry.status} · ${result.entry.messageKey ?? 'unknown'} ${
          result.entry.requestId ? `· ${result.entry.requestId}` : ''
        }`,
      );
      return;
    }
    const datasetId = String(result.envelope.data?.datasetId ?? '');
    rememberId('dataset', datasetId);
    setName('');
    setCreateOpen(false);
    await load();
    void router.push(`/demo/kb/datasets/${datasetId}`);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    const result = await api.deleteDataset(deleteTarget.datasetId, `demo-del-${Date.now()}`);
    setDeleting(false);
    if (result.entry.status !== 200) {
      setError(`${result.entry.status} · ${result.entry.messageKey ?? 'unknown'}`);
      setDeleteTarget(null);
      return;
    }
    setLastJob({
      datasetId: deleteTarget.datasetId,
      jobId: String(result.envelope.data?.jobId ?? ''),
      state: String(result.envelope.data?.state ?? ''),
    });
    setDeleteTarget(null);
    await load();
  };

  const filtered = keyword.trim()
    ? rows.filter((row) => row.name.toLowerCase().includes(keyword.trim().toLowerCase()))
    : rows;

  const failedCalls = runs.filter((run) => run.status >= 400 || run.code >= 400).length;

  return (
    <DemoShell
      title="知识库"
      breadcrumb={`共 ${total} 个 · 本页 ${rows.length} 个 · 失败调用 ${failedCalls}`}
      actions={
        <button type="button" className={`${styles.button} ${styles.buttonPrimary}`} onClick={() => setCreateOpen(true)}>
          新建知识库
        </button>
      }
    >
      {error ? (
        <div className={styles.banner}>
          列表读取失败：{error}
          <div className={styles.bannerMeta}>原因与 requestId 见右侧运行脊柱。</div>
        </div>
      ) : null}
      {lastJob ? (
        <div className={`${styles.panel} ${styles.panelPad} ${styles.mb12}`}>
          <div className={styles.flex}>
            <span>已提交删除任务</span>
            <span className={`${styles.badge} ${styles.badgeWarn}`}>{lastJob.state}</span>
            <span className={styles.mono}>{lastJob.jobId}</span>
            <Link
              className={styles.button}
              href={`/demo/kb/datasets/${lastJob.datasetId}?tab=delete`}
            >
              查看删除任务
            </Link>
          </div>
        </div>
      ) : null}

      <div className={`${styles.panel} ${styles.panelPad}`}>
        <div className={`${styles.inline} ${styles.mb12}`}>
          <Field label="搜索名称" htmlFor="dataset-search">
            <input
              id="dataset-search"
              className={styles.input}
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="按名称过滤当前页"
            />
          </Field>
          <button type="button" className={styles.button} onClick={() => void load()} disabled={loading}>
            {loading ? '刷新中…' : '刷新'}
          </button>
        </div>

        {!loading && filtered.length === 0 ? (
          <EmptyState
            title={rows.length === 0 ? '还没有知识库' : '没有匹配的知识库'}
            hint={rows.length === 0 ? '新建一个知识库，或执行 S1 场景。' : '调整搜索词后重试。'}
            action={
              rows.length === 0 ? (
                <button type="button" className={styles.button} onClick={() => setCreateOpen(true)}>
                  新建知识库
                </button>
              ) : null
            }
          />
        ) : (
          <table className={`${styles.table} ${styles.tableCardMode}`}>
            <thead>
              <tr>
                <th>名称</th>
                <th>类型</th>
                <th>模型</th>
                <th>datasetId</th>
                <th>更新时间</th>
                <th className={styles.right}>操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr key={row.datasetId}>
                  <td data-label="名称">
                    <Link href={`/demo/kb/datasets/${row.datasetId}`}>{row.name}</Link>
                  </td>
                  <td data-label="类型">{row.type}</td>
                  <td data-label="模型" className={styles.mono}>
                    {row.vectorModel ?? '—'}
                  </td>
                  <td data-label="datasetId" className={`${styles.mono} ${styles.tiny}`}>
                    {row.datasetId}
                  </td>
                  <td data-label="更新时间" className={styles.tiny}>
                    {row.updateTime ?? '—'}
                  </td>
                  <td data-label="操作" className={styles.right}>
                    <div className={styles.rowActions} style={{ justifyContent: 'flex-end' }}>
                      <Link className={`${styles.button} ${styles.buttonSmall}`} href={`/demo/kb/datasets/${row.datasetId}`}>
                        打开
                      </Link>
                      <button
                        type="button"
                        className={`${styles.button} ${styles.buttonSmall} ${styles.buttonDanger}`}
                        onClick={() => setDeleteTarget(row)}
                      >
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {createOpen ? (
        <Drawer
          title="新建知识库"
          onClose={() => setCreateOpen(false)}
          footer={
            <>
              <button type="button" className={styles.button} onClick={() => setCreateOpen(false)}>
                取消
              </button>
              <button
                type="button"
                className={`${styles.button} ${styles.buttonPrimary}`}
                onClick={() => void create()}
                disabled={creating || !name.trim()}
              >
                {creating ? '创建中…' : '创建'}
              </button>
            </>
          }
        >
          {createError ? <div className={styles.banner}>{createError}</div> : null}
          <Field label="名称" required hint="演示数据建议以 [DEMO] 开头，便于识别" htmlFor="new-dataset-name">
            <input
              id="new-dataset-name"
              className={styles.input}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="[DEMO] 验收知识库"
            />
          </Field>
          <Field label="Embedding 模型" required htmlFor="new-dataset-model">
            <select
              id="new-dataset-model"
              className={styles.select}
              value={model}
              onChange={(event) => setModel(event.target.value)}
            >
              <option value="bge-m3">bge-m3</option>
              <option value="text-embedding-3-small">text-embedding-3-small</option>
            </select>
          </Field>
        </Drawer>
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          title="删除知识库"
          targetName={deleteTarget.name}
          impact="将创建删除任务并异步清理其集合、数据、向量与对象；该操作不可撤销。"
          confirmLabel="提交删除"
          busy={deleting}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void confirmDelete()}
        />
      ) : null}
    </DemoShell>
  );
}
