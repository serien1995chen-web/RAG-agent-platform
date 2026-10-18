import Link from 'next/link';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useState } from 'react';
import { ProductShell } from '../../../../features/kb/components/product-shell';
import {
  Badge,
  Button,
  EmptyState,
  InlineError,
  Notice,
  Spinner,
  Tabs,
} from '../../../../features/kb/components/ui';
import { DocsTab } from '../../../../features/kb/components/docs-tab';
import { DataTab } from '../../../../features/kb/components/data-tab';
import { SearchTab } from '../../../../features/kb/components/search-tab';
import { TrainingTab } from '../../../../features/kb/components/training-tab';
import { PermissionTab } from '../../../../features/kb/components/permission-tab';
import { SettingsTab } from '../../../../features/kb/components/settings-tab';
import { KbRequestError, kbApi } from '../../../../features/kb/lib/kb-api';
import { datasetTypeLabel, formatDateTime } from '../../../../features/kb/lib/format';
import { useKbResource } from '../../../../features/kb/lib/use-kb-resource';
import type { TabKey } from '../../../../features/kb/types';
import styles from '../../../../features/kb/styles/kb.module.css';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'docs', label: '文档' },
  { key: 'data', label: '数据' },
  { key: 'search', label: '检索测试' },
  { key: 'training', label: '训练任务' },
  { key: 'permission', label: '权限' },
  { key: 'settings', label: '设置' },
];

function tabOf(value: unknown): TabKey {
  return TABS.some((tab) => tab.key === value) ? (value as TabKey) : 'docs';
}

export default function DatasetDetailPage() {
  const router = useRouter();
  const datasetId = typeof router.query.datasetId === 'string' ? router.query.datasetId : '';
  const tab = tabOf(router.query.tab);
  const page = Math.max(1, Number(router.query.page ?? 1) || 1);
  const collectionId =
    typeof router.query.collectionId === 'string' ? router.query.collectionId : '';
  const dataId = typeof router.query.dataId === 'string' ? router.query.dataId : '';
  const [notice, setNotice] = useState('');
  const [exportError, setExportError] = useState<unknown>(null);
  const [exporting, setExporting] = useState(false);

  const resource = useKbResource(datasetId || 'pending', () =>
    datasetId ? kbApi.getDataset(datasetId) : Promise.resolve(null),
  );
  const collectionCount = useKbResource(datasetId || 'pending', () =>
    datasetId
      ? kbApi.listCollections({ datasetId, page: 1, limit: 1 })
      : Promise.resolve({ total: 0, list: [] }),
  );
  const reload = resource.reload;

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const updateQuery = useCallback(
    (patch: Record<string, string | number | undefined>) => {
      const { datasetId: _routeDatasetId, ...baseQuery } = router.query;
      const next = { ...baseQuery, ...patch };
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

  const changeTab = (next: TabKey) => {
    updateQuery({ tab: next === 'docs' ? undefined : next, page: 1, dataId: undefined });
  };

  const onOpenCollection = useCallback(
    (nextCollectionId: string) => {
      updateQuery({ tab: 'data', collectionId: nextCollectionId, page: 1, dataId: undefined });
    },
    [updateQuery],
  );

  const onOpenCitation = useCallback(
    (nextCollectionId: string, nextDataId: string) => {
      updateQuery({
        tab: 'data',
        collectionId: nextCollectionId,
        dataId: nextDataId,
        page: 1,
      });
    },
    [updateQuery],
  );

  const onOpenDataConsumed = useCallback(() => {
    if (typeof router.query.dataId === 'string') {
      updateQuery({ dataId: undefined });
    }
  }, [router.query.dataId, updateQuery]);

  const onChanged = useCallback(() => {
    reload();
    collectionCount.reload();
  }, [collectionCount.reload, reload]);

  const exportDataset = async () => {
    const dataset = resource.data?.dataset;
    if (!dataset) return;
    setExporting(true);
    setExportError(null);
    try {
      await kbApi.exportDataset(dataset.datasetId, dataset.name);
      setNotice('导出已开始');
    } catch (caught) {
      setExportError(caught);
    } finally {
      setExporting(false);
    }
  };

  if (resource.loading && !resource.data) {
    return (
      <ProductShell title="知识库">
        <Spinner label="加载知识库" />
      </ProductShell>
    );
  }

  if (resource.error) {
    const missing =
      resource.error instanceof KbRequestError && resource.error.payload.code === 501070;
    return (
      <ProductShell
        title="知识库"
        breadcrumb={
          <Link className={styles.link} href="/dataset/list">
            返回知识库
          </Link>
        }
      >
        {missing ? (
          <EmptyState
            title="知识库不存在或不可见"
            hint="它可能已被删除，或不属于当前团队。"
            action={
              <Link className={styles.link} href="/dataset/list">
                返回知识库列表
              </Link>
            }
          />
        ) : (
          <InlineError error={resource.error} onRetry={reload} />
        )}
      </ProductShell>
    );
  }

  if (!resource.data) return null;
  const { dataset, permissionSnapshot } = resource.data;

  return (
    <ProductShell
      title="知识库"
      breadcrumb={
        <span>
          <Link className={styles.link} href="/dataset/list">
            知识库
          </Link>
          <span> / {dataset.name}</span>
        </span>
      }
      actions={
        <>
          <Button icon="download" onClick={() => void exportDataset()} loading={exporting}>
            导出
          </Button>
          <Button icon="settings" onClick={() => changeTab('settings')}>
            设置
          </Button>
        </>
      }
    >
      {notice ? <Notice tone="ok">{notice}</Notice> : null}
      {exportError ? <InlineError error={exportError} /> : null}
      <div className={styles.detailHead}>
        <div className={styles.detailTitleWrap}>
          <h2 className={styles.detailName}>
            {dataset.name}
            <Badge tone="info">{datasetTypeLabel(dataset.type)}</Badge>
          </h2>
          <div className={styles.detailMeta}>
            <span className={styles.detailMetaItem}>
              向量模型 <span className={styles.mono}>{dataset.vectorModel ?? '—'}</span>
            </span>
            <span className={styles.detailMetaItem}>
              索引版本 <span className={styles.mono}>{dataset.indexVersion ?? '—'}</span>
            </span>
            <span className={styles.detailMetaItem}>
              集合 <span className={styles.mono}>{collectionCount.data?.total ?? '—'}</span>
            </span>
            <span className={styles.detailMetaItem}>更新 {formatDateTime(dataset.updateTime)}</span>
            <span className={styles.detailMetaItem}>
              权限 <span className={styles.mono}>{permissionSnapshot?.permissionMask ?? '—'}</span>
            </span>
          </div>
        </div>
      </div>
      <Tabs value={tab} items={TABS} onChange={changeTab} />
      <div className={styles.tabPanel}>
        {tab === 'docs' ? (
          <DocsTab
            datasetId={datasetId}
            datasetName={dataset.name}
            page={page}
            onPageChange={(next) => updateQuery({ page: next })}
            onOpenData={onOpenCollection}
            onChanged={onChanged}
            onNotify={setNotice}
          />
        ) : null}
        {tab === 'data' ? (
          <DataTab
            datasetId={datasetId}
            collectionId={collectionId}
            openDataId={dataId}
            page={page}
            onPageChange={(next) => updateQuery({ page: next })}
            onCollectionChange={(next) => updateQuery({ collectionId: next, page: 1 })}
            onOpenDataConsumed={onOpenDataConsumed}
            onChanged={onChanged}
            onNotify={setNotice}
          />
        ) : null}
        {tab === 'search' ? (
          <SearchTab datasetId={datasetId} onOpenCitation={onOpenCitation} />
        ) : null}
        {tab === 'training' ? (
          <TrainingTab datasetId={datasetId} onOpenCollection={onOpenCollection} />
        ) : null}
        {tab === 'permission' ? (
          <PermissionTab datasetId={datasetId} datasetName={dataset.name} />
        ) : null}
        {tab === 'settings' ? (
          <SettingsTab dataset={dataset} onChanged={onChanged} onNotify={setNotice} />
        ) : null}
      </div>
    </ProductShell>
  );
}
