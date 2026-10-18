import Link from 'next/link';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConfirmDialog } from '../../../../demo/kb/components/drawer';
import { DemoShell } from '../../../../demo/kb/components/demo-shell';
import { EmptyState, Field, StatusText } from '../../../../demo/kb/components/primitives';
import {
  api,
  type CollectionSummary,
  type DataSummary,
  type DatasetDetailData,
  type SearchCitation,
} from '../../../../demo/kb/lib/api';
import { demoFetch } from '../../../../demo/kb/lib/demo-fetch';
import { useDemoStore } from '../../../../demo/kb/lib/use-demo-store';
import { useOnce } from '../../../../demo/kb/lib/use-once';
import styles from '../../../../demo/kb/styles/demo.module.css';

const TABS = [
  { id: 'overview', label: '概览' },
  { id: 'collections', label: '集合' },
  { id: 'data', label: '数据' },
  { id: 'search', label: '检索测试' },
  { id: 'training', label: '训练任务' },
  { id: 'delete', label: '删除任务' },
  { id: 'tags', label: '标签' },
  { id: 'permission', label: '权限' },
  { id: 'io', label: '导入导出' },
  { id: 'files', label: '文件与图片' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export default function DatasetDetailPage() {
  const router = useRouter();
  const datasetId = typeof router.query.datasetId === 'string' ? router.query.datasetId : '';
  const { runs } = useDemoStore();
  const [tab, setTab] = useState<TabId>('overview');
  const [detail, setDetail] = useState<DatasetDetailData | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [activeCollection, setActiveCollection] = useState<string>('');
  const [dataRows, setDataRows] = useState<DataSummary[]>([]);
  const [dataTotal, setDataTotal] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [textInput, setTextInput] = useState('验收平台测试文本：知识库文本导入链路。');
  const [folderName, setFolderName] = useState('[DEMO] 文件夹');
  const [linkUrl, setLinkUrl] = useState('https://example.com/doc');
  const [q, setQ] = useState('验收平台');
  const [a, setA] = useState('验收平台的回答');
  const [searchText, setSearchText] = useState('验收平台');
  const [searchMode, setSearchMode] = useState<'embedding' | 'fullText' | 'mixed'>('embedding');
  const [limit, setLimit] = useState(10);
  const [similarity, setSimilarity] = useState(0);
  const [citations, setCitations] = useState<SearchCitation[] | null>(null);
  const [searchStats, setSearchStats] = useState<Record<string, unknown> | null>(null);
  const [jobId, setJobId] = useState('');
  const [job, setJob] = useState<Record<string, unknown> | null>(null);
  const [tags, setTags] = useState<{ tagId: string; name: string }[]>([]);
  const [permission, setPermission] = useState<Record<string, unknown> | null>(null);
  const [queue, setQueue] = useState<unknown>(null);
  const [ioResult, setIoResult] = useState<string | null>(null);

  useEffect(() => {
    if (typeof router.query.tab === 'string' && TABS.some((item) => item.id === router.query.tab)) {
      setTab(router.query.tab as TabId);
    }
  }, [router.query.tab]);

  const loadDetail = useCallback(async () => {
    if (!datasetId) return;
    const result = await api.getDataset(datasetId);
    if (!result.ok) {
      setDetailError(`${result.entry.status} · ${result.entry.messageKey ?? 'unknown'}`);
      return;
    }
    setDetailError(null);
    setDetail(result.envelope.data ?? null);
  }, [datasetId]);

  const loadCollections = useCallback(async () => {
    if (!datasetId) return;
    const result = await api.listCollections({ datasetId });
    if (!result.ok) return;
    const list = result.envelope.data?.list ?? [];
    setCollections(list);
    setActiveCollection((current) => current || list[0]?.collectionId || '');
  }, [datasetId]);

  const loadData = useCallback(async (collectionId: string) => {
    if (!collectionId) return;
    const result = await api.listData({ collectionId });
    if (!result.ok) return;
    setDataRows(result.envelope.data?.list ?? []);
    setDataTotal(result.envelope.data?.total ?? 0);
  }, []);

  useOnce(() => {
    void loadDetail();
    void loadCollections();
  });

  useEffect(() => {
    if (activeCollection) void loadData(activeCollection);
  }, [activeCollection, loadData]);

  const track = (label: string, ok: boolean, code?: string) => {
    setBusy(null);
    if (ok) {
      setActionError(null);
      setActionNote(`${label}成功${code ? `（${code}）` : ''}`);
    } else {
      setActionNote(null);
      setActionError(`${label}失败：${code ?? '见右侧运行脊柱'}`);
    }
  };

  const createText = async () => {
    if (!datasetId) return;
    setBusy('text');
    const result = await api.createTextCollection({ datasetId, text: textInput });
    track('创建文本集合', result.ok, `${result.entry.status}/${result.entry.code}`);
    if (result.ok) {
      await loadCollections();
      if (result.envelope.data?.collectionId)
        setActiveCollection(String(result.envelope.data.collectionId));
    }
  };

  const createFolder = async () => {
    if (!datasetId) return;
    setBusy('folder');
    const result = await api.createFolderCollection({ datasetId, name: folderName });
    track('创建文件夹', result.ok, `${result.entry.status}/${result.entry.code}`);
    if (result.ok) await loadCollections();
  };

  const createLink = async () => {
    if (!datasetId) return;
    setBusy('link');
    const result = await api.createLinkCollection({ datasetId, link: linkUrl });
    track('创建链接集合', result.ok, `${result.entry.status}/${result.entry.code}`);
    if (result.ok) await loadCollections();
  };

  const deleteCollection = async (collectionId: string) => {
    setBusy(collectionId);
    const result = await api.deleteCollection(collectionId, `demo-col-del-${Date.now()}`);
    track('删除集合', result.entry.status === 200, `${result.entry.status}/${result.entry.code}`);
    if (result.entry.status === 200) {
      await loadCollections();
      setActiveCollection('');
    }
  };

  const insertData = async () => {
    if (!activeCollection) return;
    setBusy('insert');
    const result = await api.insertData({ collectionId: activeCollection, q, a });
    track('直接插入', result.ok, `${result.entry.status}/${result.entry.code}`);
    if (result.ok) await loadData(activeCollection);
  };

  const pushData = async () => {
    if (!activeCollection) return;
    setBusy('push');
    const result = await api.pushData({
      collectionId: activeCollection,
      items: [{ q: `${q}（批量一）` }, { q: `${q}（批量二）`, a }],
    });
    track('批量推送', result.ok, `${result.entry.status}/${result.entry.code}`);
    if (result.ok) await loadData(activeCollection);
  };

  const runSearch = async () => {
    if (!datasetId) return;
    setBusy('search');
    const result = await api.searchTest({
      datasetId,
      text: searchText,
      limit,
      similarity,
      searchMode,
    });
    setBusy(null);
    if (!result.ok) {
      setActionError(`检索失败：${result.entry.status}/${result.entry.code}`);
      setCitations(null);
      return;
    }
    setActionError(null);
    setCitations(result.envelope.data?.searchRes?.citations ?? []);
    setSearchStats(
      (result.envelope.data?.searchRes?.stats ?? null) as Record<string, unknown> | null,
    );
  };

  const loadJob = async () => {
    if (!jobId) return;
    setBusy('job');
    const result = await api.getDeleteJob(jobId);
    setBusy(null);
    if (!result.ok) {
      setActionError(`删除任务读取失败：${result.entry.status}/${result.entry.code}`);
      return;
    }
    setActionError(null);
    setJob(result.envelope.data as unknown as Record<string, unknown>);
  };

  const loadPermission = async () => {
    if (!datasetId) return;
    const result = await api.getPermission(datasetId);
    if (result.ok) setPermission(result.envelope.data as unknown as Record<string, unknown>);
    else setActionError(`权限读取失败：${result.entry.status}/${result.entry.code}`);
  };

  const loadTags = async () => {
    if (!datasetId) return;
    const result = await api.listTags(datasetId);
    if (result.ok) setTags(result.envelope.data?.list ?? []);
    else setActionError(`标签读取失败：${result.entry.status}/${result.entry.code}`);
  };

  const loadQueue = async () => {
    if (!datasetId) return;
    const result = await api.trainingQueue(datasetId);
    if (result.ok) setQueue(result.envelope.data?.modes ?? []);
    else setActionError(`训练队列读取失败：${result.entry.status}/${result.entry.code}`);
  };

  const rebuild = async () => {
    if (!datasetId || !detail) return;
    setBusy('rebuild');
    const result = await api.rebuildEmbedding({
      datasetId,
      modelRef: {
        provider: 'openai',
        model: detail.dataset.vectorModel ?? 'bge-m3',
        dimension: 1536,
      },
    });
    track('重建向量', result.ok, `${result.entry.status}/${result.entry.code}`);
  };

  const removeDataset = async () => {
    if (!datasetId) return;
    setBusy('delete');
    const result = await api.deleteDataset(datasetId, `demo-ds-del-${Date.now()}`);
    setConfirmDelete(false);
    track('删除知识库', result.entry.status === 200, `${result.entry.status}/${result.entry.code}`);
    if (result.entry.status === 200) {
      setJobId(String(result.envelope.data?.jobId ?? ''));
      await router.push(`/demo/kb/datasets/${datasetId}?tab=delete`);
    }
  };

  const exportDataset = async () => {
    if (!datasetId) return;
    setBusy('export');
    const result = await demoFetch({
      method: 'GET',
      path: `/api/core/dataset/exportAll?datasetId=${encodeURIComponent(datasetId)}`,
    });
    setBusy(null);
    setIoResult(
      result.ok
        ? `导出请求成功（HTTP ${result.entry.status}，响应体见运行脊柱）`
        : `导出失败：${result.entry.status}/${result.entry.code}`,
    );
  };

  const presign = async () => {
    if (!datasetId) return;
    setBusy('presign');
    const result = await demoFetch({
      method: 'POST',
      path: '/api/core/dataset/file/presignUpload',
      body: { datasetId, fileName: 'demo.txt', size: 18, mimeType: 'text/plain' },
    });
    track('申请上传签名', result.ok, `${result.entry.status}/${result.entry.code}`);
  };

  const failedCount = useMemo(
    () => runs.filter((run) => run.status >= 400 || run.code >= 400).length,
    [runs],
  );

  if (!datasetId) {
    return (
      <DemoShell title="知识库详情">
        <EmptyState title="缺少 datasetId" hint="从知识库列表进入。" />
      </DemoShell>
    );
  }

  return (
    <DemoShell
      title={detail?.dataset.name ?? '知识库详情'}
      breadcrumb={
        <span>
          <Link href="/demo/kb/datasets">知识库</Link> /{' '}
          <span className={styles.mono}>{datasetId}</span>
        </span>
      }
      actions={
        <button
          type="button"
          className={`${styles.button} ${styles.buttonDanger}`}
          onClick={() => setConfirmDelete(true)}
        >
          删除知识库
        </button>
      }
    >
      {detailError ? <div className={styles.banner}>详情读取失败：{detailError}</div> : null}
      {actionError ? <div className={styles.banner}>{actionError}</div> : null}
      {actionNote ? (
        <div className={`${styles.panel} ${styles.panelPad} ${styles.mb12}`}>
          <span className={`${styles.badge} ${styles.badgeOk}`}>完成</span> {actionNote}
        </div>
      ) : null}

      <div className={styles.tabs} role="tablist">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`${styles.tab} ${tab === item.id ? styles.tabActive : ''}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'overview' ? (
        <div className={styles.split}>
          <section className={`${styles.panel} ${styles.panelPad}`}>
            <h2 className={styles.sectionTitle}>基本信息</h2>
            <div className={styles.kv}>
              <span className={styles.kvKey}>名称</span>
              <span>{detail?.dataset.name ?? '—'}</span>
              <span className={styles.kvKey}>类型</span>
              <span>{detail?.dataset.type ?? '—'}</span>
              <span className={styles.kvKey}>向量模型</span>
              <span className={styles.mono}>{detail?.dataset.vectorModel ?? '—'}</span>
              <span className={styles.kvKey}>indexVersion</span>
              <span className={styles.mono}>{detail?.dataset.indexVersion ?? '—'}</span>
              <span className={styles.kvKey}>集合数</span>
              <span>{detail?.stats.collections ?? '—'}</span>
              <span className={styles.kvKey}>数据数</span>
              <span>{detail?.stats.datas ?? '—'}</span>
            </div>
            <div className={`${styles.rowActions} ${styles.mt16}`}>
              <button
                type="button"
                className={styles.button}
                onClick={() => void rebuild()}
                disabled={busy === 'rebuild'}
              >
                {busy === 'rebuild' ? '重建中…' : '重建向量'}
              </button>
              <button type="button" className={styles.button} onClick={() => void loadDetail()}>
                刷新
              </button>
            </div>
          </section>
          <section className={`${styles.panel} ${styles.panelPad}`}>
            <h2 className={styles.sectionTitle}>本次会话</h2>
            <div className={styles.kv}>
              <span className={styles.kvKey}>调用</span>
              <span className={styles.mono}>{runs.length}</span>
              <span className={styles.kvKey}>失败</span>
              <span className={styles.mono}>{failedCount}</span>
            </div>
            <div className={styles.tiny}>证据在右侧运行脊柱，可逐条导出。</div>
          </section>
        </div>
      ) : null}

      {tab === 'collections' ? (
        <div className={styles.split}>
          <section className={`${styles.panel} ${styles.panelPad}`}>
            <div className={styles.flex}>
              <h2 className={styles.sectionTitle}>集合（{collections.length}）</h2>
              <span className={styles.topSpacer} />
              <button
                type="button"
                className={styles.button}
                onClick={() => void loadCollections()}
              >
                刷新
              </button>
            </div>
            {collections.length === 0 ? (
              <EmptyState title="还没有集合" hint="在下方创建文本、文件夹或链接集合。" />
            ) : (
              <table className={`${styles.table} ${styles.tableCardMode}`}>
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>类型</th>
                    <th>训练状态</th>
                    <th>训练模式</th>
                    <th className={styles.right}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {collections.map((row) => (
                    <tr key={row.collectionId}>
                      <td data-label="名称">
                        <button
                          type="button"
                          className={styles.button}
                          style={{ border: 'none', padding: 0, color: 'inherit' }}
                          onClick={() => {
                            setActiveCollection(row.collectionId);
                            setTab('data');
                          }}
                        >
                          {row.name}
                        </button>
                      </td>
                      <td data-label="类型">{row.type}</td>
                      <td data-label="训练状态">
                        <StatusText
                          status={
                            row.trainingState === 'ready'
                              ? 'passed'
                              : row.trainingState === 'error'
                                ? 'failed'
                                : 'running'
                          }
                          label={row.trainingState ?? 'unknown'}
                        />
                      </td>
                      <td data-label="训练模式" className={styles.mono}>
                        {row.trainingMode ?? '—'}
                      </td>
                      <td data-label="操作" className={styles.right}>
                        <button
                          type="button"
                          className={`${styles.button} ${styles.buttonSmall} ${styles.buttonDanger}`}
                          onClick={() => void deleteCollection(row.collectionId)}
                          disabled={busy === row.collectionId}
                        >
                          {busy === row.collectionId ? '删除中…' : '删除'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className={`${styles.panel} ${styles.panelPad}`}>
            <h2 className={styles.sectionTitle}>创建集合</h2>
            <Field label="文本内容" htmlFor="col-text">
              <textarea
                id="col-text"
                className={styles.textarea}
                value={textInput}
                onChange={(event) => setTextInput(event.target.value)}
              />
            </Field>
            <button
              type="button"
              className={styles.button}
              onClick={() => void createText()}
              disabled={busy === 'text'}
            >
              {busy === 'text' ? '创建中…' : '创建文本集合'}
            </button>
            <div className={styles.mt16}>
              <Field label="文件夹名称" htmlFor="col-folder">
                <input
                  id="col-folder"
                  className={styles.input}
                  value={folderName}
                  onChange={(event) => setFolderName(event.target.value)}
                />
              </Field>
              <button
                type="button"
                className={styles.button}
                onClick={() => void createFolder()}
                disabled={busy === 'folder'}
              >
                创建文件夹
              </button>
            </div>
            <div className={styles.mt16}>
              <Field label="链接" hint="需要后端可访问该 URL" htmlFor="col-link">
                <input
                  id="col-link"
                  className={styles.input}
                  value={linkUrl}
                  onChange={(event) => setLinkUrl(event.target.value)}
                />
              </Field>
              <button
                type="button"
                className={styles.button}
                onClick={() => void createLink()}
                disabled={busy === 'link'}
              >
                创建链接集合
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {tab === 'data' ? (
        <section className={`${styles.panel} ${styles.panelPad}`}>
          <div className={styles.flex}>
            <h2 className={styles.sectionTitle}>数据</h2>
            <select
              className={styles.select}
              style={{ width: 240 }}
              value={activeCollection}
              onChange={(event) => setActiveCollection(event.target.value)}
              aria-label="选择集合"
            >
              <option value="">选择集合</option>
              {collections.map((row) => (
                <option key={row.collectionId} value={row.collectionId}>
                  {row.name}
                </option>
              ))}
            </select>
            <span className={styles.topSpacer} />
            <span className={styles.tiny}>total {dataTotal}</span>
            <button
              type="button"
              className={styles.button}
              onClick={() => void loadData(activeCollection)}
            >
              刷新
            </button>
          </div>
          <div className={styles.mt12}>
            {!activeCollection ? (
              <EmptyState title="先选择一个集合" hint="集合标签页可创建文本集合。" />
            ) : dataRows.length === 0 ? (
              <EmptyState
                title="该集合暂无数据"
                hint="训练完成后数据才会出现；也可直接插入一条。"
              />
            ) : (
              <table className={`${styles.table} ${styles.tableCardMode}`}>
                <thead>
                  <tr>
                    <th>dataId</th>
                    <th>q</th>
                    <th>a</th>
                    <th>更新时间</th>
                  </tr>
                </thead>
                <tbody>
                  {dataRows.map((row) => (
                    <tr key={row.dataId}>
                      <td data-label="dataId" className={`${styles.mono} ${styles.tiny}`}>
                        {row.dataId}
                      </td>
                      <td data-label="q">{row.q ?? '—'}</td>
                      <td data-label="a">{row.a ?? '—'}</td>
                      <td data-label="更新时间" className={styles.tiny}>
                        {row.updateTime ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div className={`${styles.split} ${styles.mt16}`}>
            <div>
              <Field label="q（问题）" htmlFor="data-q">
                <input
                  id="data-q"
                  className={styles.input}
                  value={q}
                  onChange={(event) => setQ(event.target.value)}
                />
              </Field>
              <Field label="a（回答，可选）" htmlFor="data-a">
                <input
                  id="data-a"
                  className={styles.input}
                  value={a}
                  onChange={(event) => setA(event.target.value)}
                />
              </Field>
              <div className={styles.rowActions}>
                <button
                  type="button"
                  className={styles.button}
                  onClick={() => void insertData()}
                  disabled={busy === 'insert' || !activeCollection}
                >
                  {busy === 'insert' ? '插入中…' : '直接插入'}
                </button>
                <button
                  type="button"
                  className={styles.button}
                  onClick={() => void pushData()}
                  disabled={busy === 'push' || !activeCollection}
                >
                  {busy === 'push' ? '推送中…' : '批量推送 2 条'}
                </button>
              </div>
            </div>
            <div className={styles.tiny}>
              直接插入不经过训练队列，但需要 Embedding；未配置模型时返回 501062。
            </div>
          </div>
        </section>
      ) : null}

      {tab === 'search' ? (
        <div className={styles.split}>
          <section className={`${styles.panel} ${styles.panelPad}`}>
            <h2 className={styles.sectionTitle}>检索</h2>
            <Field label="查询文本" htmlFor="search-text">
              <input
                id="search-text"
                className={styles.input}
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
              />
            </Field>
            <div className={styles.inline}>
              <Field label="模式" htmlFor="search-mode">
                <select
                  id="search-mode"
                  className={styles.select}
                  value={searchMode}
                  onChange={(event) => setSearchMode(event.target.value as typeof searchMode)}
                >
                  <option value="embedding">embedding</option>
                  <option value="fullText">fullText</option>
                  <option value="mixed">mixed</option>
                </select>
              </Field>
              <Field label="TopK" htmlFor="search-limit">
                <input
                  id="search-limit"
                  className={styles.input}
                  type="number"
                  min={1}
                  max={50}
                  value={limit}
                  onChange={(event) =>
                    setLimit(Math.max(1, Math.min(50, Number(event.target.value) || 1)))
                  }
                />
              </Field>
              <Field label="相似度阈值" htmlFor="search-sim">
                <input
                  id="search-sim"
                  className={styles.input}
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={similarity}
                  onChange={(event) =>
                    setSimilarity(Math.max(0, Math.min(1, Number(event.target.value) || 0)))
                  }
                />
              </Field>
            </div>
            <button
              type="button"
              className={styles.button}
              onClick={() => void runSearch()}
              disabled={busy === 'search'}
            >
              {busy === 'search' ? '检索中…' : '执行检索'}
            </button>
          </section>
          <section className={`${styles.panel} ${styles.panelPad}`}>
            <h2 className={styles.sectionTitle}>结果</h2>
            {citations === null ? (
              <EmptyState title="尚未检索" hint="配置查询后执行。" />
            ) : citations.length === 0 ? (
              <EmptyState title="0 命中" hint="训练未完成或 Embedding 未配置时会出现该结果。" />
            ) : (
              <div className={styles.timeline}>
                {citations.map((item, index) => (
                  <div key={`${item.dataId ?? index}`} className={styles.timelineRow}>
                    <span className={styles.timelineDot} style={{ background: 'var(--ok)' }} />
                    <div>
                      <div className={styles.small}>{item.quoteText ?? item.sourceName ?? '—'}</div>
                      <div className={`${styles.tiny} ${styles.mono}`}>
                        {item.dataId ?? '—'} · {item.collectionId ?? '—'}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {searchStats ? (
              <>
                <div className={`${styles.kvKey} ${styles.mt12}`}>stats</div>
                <pre className={styles.codeBlock}>{JSON.stringify(searchStats, null, 2)}</pre>
              </>
            ) : null}
          </section>
        </div>
      ) : null}

      {tab === 'training' ? (
        <section className={`${styles.panel} ${styles.panelPad}`}>
          <div className={styles.flex}>
            <h2 className={styles.sectionTitle}>训练队列</h2>
            <span className={styles.topSpacer} />
            <button type="button" className={styles.button} onClick={() => void loadQueue()}>
              刷新
            </button>
          </div>
          {queue === null ? (
            <EmptyState title="尚未读取" hint="点击刷新读取 training/queue。" />
          ) : (
            <pre className={styles.codeBlock}>{JSON.stringify(queue, null, 2)}</pre>
          )}
          <div className={`${styles.tiny} ${styles.mt8}`}>
            队列由 Worker 消费；未启动 Worker 时任务会停留在 queued。
          </div>
        </section>
      ) : null}

      {tab === 'delete' ? (
        <section className={`${styles.panel} ${styles.panelPad}`}>
          <h2 className={styles.sectionTitle}>删除任务</h2>
          <div className={styles.inline}>
            <Field label="jobId" htmlFor="job-id">
              <input
                id="job-id"
                className={`${styles.input} ${styles.mono}`}
                value={jobId}
                onChange={(event) => setJobId(event.target.value)}
                placeholder="粘贴删除返回的 jobId"
              />
            </Field>
            <button
              type="button"
              className={styles.button}
              onClick={() => void loadJob()}
              disabled={busy === 'job'}
            >
              {busy === 'job' ? '读取中…' : '读取任务'}
            </button>
          </div>
          {job ? (
            <pre className={styles.codeBlock}>{JSON.stringify(job, null, 2)}</pre>
          ) : (
            <EmptyState title="尚未读取任务" hint="删除知识库后会自动填入 jobId。" />
          )}
        </section>
      ) : null}

      {tab === 'tags' ? (
        <section className={`${styles.panel} ${styles.panelPad}`}>
          <div className={styles.flex}>
            <h2 className={styles.sectionTitle}>标签</h2>
            <span className={styles.topSpacer} />
            <button type="button" className={styles.button} onClick={() => void loadTags()}>
              读取标签
            </button>
          </div>
          {tags.length === 0 ? (
            <EmptyState
              title="暂无标签"
              hint="标签创建能力按后端支持度展示；未提供时不会伪造入口。"
            />
          ) : (
            <ul>
              {tags.map((tag) => (
                <li key={tag.tagId}>
                  {tag.name} <span className={`${styles.mono} ${styles.tiny}`}>{tag.tagId}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {tab === 'permission' ? (
        <section className={`${styles.panel} ${styles.panelPad}`}>
          <div className={styles.flex}>
            <h2 className={styles.sectionTitle}>权限快照</h2>
            <span className={styles.topSpacer} />
            <button type="button" className={styles.button} onClick={() => void loadPermission()}>
              读取权限
            </button>
          </div>
          {permission ? (
            <pre className={styles.codeBlock}>{JSON.stringify(permission, null, 2)}</pre>
          ) : (
            <EmptyState
              title="尚未读取"
              hint="协作者变更需要第二个身份；当前开发态为固定单身份。"
            />
          )}
          <div className={styles.mt12}>
            <Link
              className={styles.button}
              href={`/proApi/core/dataset/collaborator/list?datasetId=${datasetId}`}
              target="_blank"
            >
              打开协作者列表（/proApi）
            </Link>
          </div>
        </section>
      ) : null}

      {tab === 'io' ? (
        <section className={`${styles.panel} ${styles.panelPad}`}>
          <h2 className={styles.sectionTitle}>导入导出</h2>
          <div className={styles.rowActions}>
            <button
              type="button"
              className={styles.button}
              onClick={() => void exportDataset()}
              disabled={busy === 'export'}
            >
              {busy === 'export' ? '导出中…' : '导出 Dataset'}
            </button>
            <Link className={styles.button} href="/demo/kb/coverage">
              查看导入相关路由覆盖
            </Link>
          </div>
          {ioResult ? <div className={`${styles.mt12} ${styles.small}`}>{ioResult}</div> : null}
          <div className={`${styles.tiny} ${styles.mt8}`}>
            浏览器直接下载 zip 需要后端返回二进制；demo 只记录请求结果，不伪造文件内容。
          </div>
        </section>
      ) : null}

      {tab === 'files' ? (
        <section className={`${styles.panel} ${styles.panelPad}`}>
          <h2 className={styles.sectionTitle}>文件与图片</h2>
          <div className={styles.rowActions}>
            <button
              type="button"
              className={styles.button}
              onClick={() => void presign()}
              disabled={busy === 'presign'}
            >
              {busy === 'presign' ? '申请中…' : '申请上传签名'}
            </button>
          </div>
          <div className={`${styles.tiny} ${styles.mt12}`}>
            图片集合、分片上传与预览依赖 MinIO 与图片处理 Port；未接入时返回 501999 /
            501062，会如实显示。
          </div>
        </section>
      ) : null}

      {confirmDelete ? (
        <ConfirmDialog
          title="删除知识库"
          targetName={detail?.dataset.name ?? datasetId}
          impact="将创建删除任务并异步清理集合、数据、向量与对象；不可撤销。"
          confirmLabel="提交删除"
          busy={busy === 'delete'}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => void removeDataset()}
        />
      ) : null}
    </DemoShell>
  );
}
