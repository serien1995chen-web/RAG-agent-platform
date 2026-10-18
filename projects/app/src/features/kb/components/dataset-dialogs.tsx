import { useState } from 'react';
import { kbApi } from '../lib/kb-api';
import type { DatasetSummary } from '../types';
import styles from '../styles/kb.module.css';
import { useKbResource } from '../lib/use-kb-resource';
import { Button, Drawer, Field, InlineError, Input, Spinner } from './ui';

export function DatasetCreateDrawer({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (input: { datasetId: string; type: 'dataset' | 'folder'; name: string }) => void;
}) {
  const [type, setType] = useState<'dataset' | 'folder'>('dataset');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const trimmed = name.trim();

  const submit = async () => {
    if (!trimmed) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await kbApi.createDataset({
        name: trimmed,
        type,
        ...(type === 'dataset' ? { embeddingModel: 'bge-m3' } : {}),
      });
      onCreated({ datasetId: result.datasetId, type, name: trimmed });
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Drawer
      title="新建"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            loading={submitting}
            disabled={!trimmed}
          >
            新建
          </Button>
        </>
      }
    >
      {error ? <InlineError error={error} /> : null}
      <Field label="类型" required>
        <div className={styles.segmented} role="group" aria-label="新建类型">
          <button
            type="button"
            className={`${styles.segment} ${type === 'dataset' ? styles.segmentActive : ''}`}
            onClick={() => setType('dataset')}
          >
            知识库
          </button>
          <button
            type="button"
            className={`${styles.segment} ${type === 'folder' ? styles.segmentActive : ''}`}
            onClick={() => setType('folder')}
          >
            文件夹
          </button>
        </div>
      </Field>
      <Field
        label="名称"
        required
        hint={`${trimmed.length}/100，名称在当前文件夹内唯一`}
        error={trimmed.length > 100 ? '名称不能超过 100 个字符' : undefined}
      >
        <Input
          autoFocus
          value={name}
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
          placeholder={type === 'dataset' ? '例如：产品文档' : '例如：研发资料'}
        />
      </Field>
      {type === 'dataset' ? (
        <Field label="向量模型" hint="模型目录与能力由后续 Model & AI 模块接入；当前使用默认模型。">
          <Input value="bge-m3" readOnly aria-readonly="true" />
        </Field>
      ) : null}
    </Drawer>
  );
}

export function DatasetRenameDrawer({
  dataset,
  onClose,
  onRenamed,
}: {
  dataset: DatasetSummary;
  onClose: () => void;
  onRenamed: () => void;
}) {
  const resource = useKbResource(`rename:${dataset.datasetId}`, () =>
    kbApi.getDataset(dataset.datasetId),
  );
  const [name, setName] = useState(dataset.name);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async () => {
    const version = resource.data?.dataset.version;
    const trimmed = name.trim();
    if (!version || !trimmed) return;
    setSubmitting(true);
    setError(null);
    try {
      await kbApi.updateDataset({ datasetId: dataset.datasetId, version, name: trimmed });
      onRenamed();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Drawer
      title="重命名"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            loading={submitting}
            disabled={!resource.data || !name.trim()}
          >
            保存
          </Button>
        </>
      }
    >
      {resource.loading ? <Spinner label="读取当前版本" /> : null}
      {resource.error ? <InlineError error={resource.error} onRetry={resource.reload} /> : null}
      {error ? <InlineError error={error} /> : null}
      <Field label="名称" required hint="保存时会校验版本；若已被修改，请刷新后重试。">
        <Input
          autoFocus
          value={name}
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
    </Drawer>
  );
}
