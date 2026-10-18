import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { kbApi, modelMode } from '../lib/kb-api';
import type { DatasetSummary } from '../types';
import styles from '../styles/kb.module.css';
import { Badge, Button, ConfirmDialog, Field, InlineError, Input, Notice } from './ui';
import { DeleteJobDrawer } from './delete-job-drawer';

export function SettingsTab({
  dataset,
  onChanged,
  onNotify,
}: {
  dataset: DatasetSummary;
  onChanged: () => void;
  onNotify: (message: string) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(dataset.name);
  const [autoSync, setAutoSync] = useState(Boolean(dataset.autoSync));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<unknown>(null);
  const [jobId, setJobId] = useState('');
  const onDeleteFinished = useCallback(() => {
    void router.push('/dataset/list');
  }, [router]);

  useEffect(() => {
    setName(dataset.name);
    setAutoSync(Boolean(dataset.autoSync));
  }, [dataset.name, dataset.autoSync]);

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await kbApi.updateDataset({
        datasetId: dataset.datasetId,
        version: dataset.version,
        name: name.trim(),
        autoSync,
      });
      onNotify('设置已保存');
      onChanged();
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      const job = await kbApi.deleteDataset(dataset.datasetId);
      if (job.jobId) setJobId(job.jobId);
      setConfirmDelete(false);
    } catch (caught) {
      setDeleteError(caught);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className={styles.section}>
      {error ? <InlineError error={error} /> : null}
      {deleteError ? <InlineError error={deleteError} /> : null}
      <div className={styles.sectionHead}>
        <h3 className={styles.sectionTitle}>基本信息</h3>
      </div>
      <div className={styles.formGrid}>
        <Field label="名称" required hint="保存时校验版本；冲突会提示刷新。">
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="自动同步" hint="仅对支持同步的来源（链接 / API 文件）有意义。">
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={autoSync}
              onChange={(event) => setAutoSync(event.target.checked)}
            />
            开启自动同步
          </label>
        </Field>
      </div>
      <Button
        variant="primary"
        onClick={() => void save()}
        loading={saving}
        disabled={
          !name.trim() || (name.trim() === dataset.name && autoSync === Boolean(dataset.autoSync))
        }
      >
        保存
      </Button>

      <div className={styles.divider} />
      <div className={styles.sectionHead}>
        <h3 className={styles.sectionTitle}>模型信息</h3>
        {modelMode() === 'mock' ? <Badge tone="warn">Mock 模型</Badge> : null}
      </div>
      <div className={styles.detailMeta}>
        <span className={styles.detailMetaItem}>
          向量模型 <span className={styles.mono}>{dataset.vectorModel ?? '—'}</span>
        </span>
        <span className={styles.detailMetaItem}>
          索引版本 <span className={styles.mono}>{dataset.indexVersion ?? '—'}</span>
        </span>
      </div>
      <Notice tone="info">
        模型目录与能力由后续 Model &amp; AI 模块接入；当前只读展示，不提供模型切换。
      </Notice>
      <Button disabled title="重建到相同模型会被后端拒绝；切换模型需要 Model & AI 模块提供模型目录">
        重建向量（待接入）
      </Button>

      <div className={styles.dangerZone}>
        <h4>危险区</h4>
        <div className={styles.muted}>删除知识库会异步清理集合、数据和索引。删除后不可撤销。</div>
        <div className={styles.mt8}>
          <Button variant="danger" onClick={() => setConfirmDelete(true)}>
            删除知识库
          </Button>
        </div>
      </div>

      <div className={styles.divider} />
      <a className={styles.link} href="/demo/kb">
        打开开发者验收控制台
      </a>

      {confirmDelete ? (
        <ConfirmDialog
          title="删除知识库"
          target={dataset.name}
          impact="将提交异步删除任务；知识库、集合、数据与索引会被清理。此操作不可撤销。"
          confirmLabel="确认删除"
          busy={deleting}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => void remove()}
        />
      ) : null}
      {jobId ? (
        <DeleteJobDrawer jobId={jobId} onClose={() => setJobId('')} onFinished={onDeleteFinished} />
      ) : null}
    </div>
  );
}
