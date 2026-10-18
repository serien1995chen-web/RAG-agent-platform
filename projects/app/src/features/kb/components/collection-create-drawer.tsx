import { useState } from 'react';
import { kbApi, uploadFile } from '../lib/kb-api';
import { KbValidationError } from '../lib/validation';
import type { CreateCollectionResult } from '../types';
import styles from '../styles/kb.module.css';
import { Button, Drawer, Field, InlineError, Input, Select, Textarea } from './ui';

type CreateMode = 'text' | 'folder' | 'link' | 'empty' | 'file' | 'image';

const MODE_LABEL: Record<CreateMode, string> = {
  text: '文本',
  folder: '文件夹',
  link: '链接',
  empty: '空集合',
  file: '文件',
  image: '图片',
};

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export function CollectionCreateDrawer({
  datasetId,
  onClose,
  onCreated,
}: {
  datasetId: string;
  onClose: () => void;
  onCreated: (result: CreateCollectionResult, message: string) => void;
}) {
  const [mode, setMode] = useState<CreateMode>('text');
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [link, setLink] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [stage, setStage] = useState('');
  const [error, setError] = useState<unknown>(null);

  const canSubmit =
    mode === 'text'
      ? text.trim().length > 0
      : mode === 'link'
        ? /^https?:\/\//i.test(link.trim())
        : mode === 'file' || mode === 'image'
          ? Boolean(file)
          : name.trim().length > 0;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    setStage('');
    try {
      if (mode === 'text') {
        const result = await kbApi.createTextCollection(datasetId, text.trim());
        onCreated(result, '文本集合已创建，正在训练');
      } else if (mode === 'folder') {
        const result = await kbApi.createFolderCollection(datasetId, name.trim());
        onCreated(result, '文件夹已创建');
      } else if (mode === 'link') {
        const result = await kbApi.createLinkCollection(datasetId, link.trim());
        onCreated(result, '链接集合已创建，正在抓取并训练');
      } else if (mode === 'empty') {
        const result = await kbApi.createEmptyCollection(datasetId, name.trim());
        onCreated(result, '空集合已创建');
      } else {
        if (!file) return;
        if (file.size > MAX_UPLOAD_BYTES) {
          throw new KbValidationError('文件超过 10MB 上限');
        }
        const uploaded = await uploadFile(datasetId, file, setStage);
        if (mode === 'file') {
          const result = await kbApi.createFileCollection(datasetId, uploaded.fileRef);
          onCreated(result, '文件已上传，正在解析并训练');
        } else {
          const result = await kbApi.createImagesCollection(datasetId, [uploaded.fileRef]);
          const failed = result.items.find((item) => item.state !== 'success');
          if (failed) {
            throw new KbValidationError(failed.errorMsg ?? '图片处理失败');
          }
          onCreated(
            { collectionId: result.collectionId },
            `图片集合已创建（${result.items.length} 张）`,
          );
        }
      }
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setSubmitting(false);
      setStage('');
    }
  };

  return (
    <Drawer
      title="新建集合"
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
            disabled={!canSubmit}
          >
            {stage || '创建'}
          </Button>
        </>
      }
    >
      {error ? <InlineError error={error} /> : null}
      <Field label="来源" required>
        <div className={styles.modeGrid}>
          {(Object.keys(MODE_LABEL) as CreateMode[]).map((item) => (
            <button
              key={item}
              type="button"
              className={`${styles.modeButton} ${mode === item ? styles.modeButtonActive : ''}`}
              onClick={() => setMode(item)}
            >
              {MODE_LABEL[item]}
            </button>
          ))}
        </div>
      </Field>

      {mode === 'text' ? (
        <Field label="文本" required hint="按当前数据集的分段策略训练为可检索数据。">
          <Textarea
            autoFocus
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="粘贴要导入的文本…"
          />
        </Field>
      ) : null}
      {mode === 'folder' || mode === 'empty' ? (
        <Field label="名称" required>
          <Input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={mode === 'folder' ? '例如：产品资料' : '例如：手工维护集合'}
          />
        </Field>
      ) : null}
      {mode === 'link' ? (
        <Field
          label="链接"
          required
          hint="仅支持公开 http(s) 页面；内网地址会被拒绝。抓取依赖出网环境。"
        >
          <Input
            autoFocus
            value={link}
            onChange={(event) => setLink(event.target.value)}
            placeholder="https://example.com/docs"
          />
        </Field>
      ) : null}
      {mode === 'file' || mode === 'image' ? (
        <Field
          label={mode === 'file' ? '文件' : '图片'}
          required
          hint={
            mode === 'file'
              ? '支持后端可解析的文档格式；单个文件不超过 10MB。'
              : '支持 PNG/JPEG/WebP/GIF；创建后以 auto 模式处理图片向量。'
          }
        >
          <input
            className={styles.fileInput}
            type="file"
            accept={mode === 'image' ? 'image/png,image/jpeg,image/webp,image/gif' : undefined}
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </Field>
      ) : null}
    </Drawer>
  );
}

export function CollectionImportDrawer({
  datasetId,
  collections,
  defaultCollectionId,
  onClose,
  onImported,
}: {
  datasetId: string;
  collections: { collectionId: string; name: string }[];
  defaultCollectionId?: string;
  onClose: () => void;
  onImported: (message: string) => void;
}) {
  const [target, setTarget] = useState(defaultCollectionId ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [report, setReport] = useState('');

  const submit = async () => {
    if (!file) return;
    setSubmitting(true);
    setError(null);
    setReport('');
    try {
      const form = new FormData();
      form.append('datasetId', datasetId);
      if (target) form.append('targetCollectionId', target);
      form.append('file', file);
      const result = await kbApi.importCollection(form);
      const summary = result.report;
      const message = summary
        ? `导入完成：成功 ${summary.success ?? 0}，跳过 ${summary.skipped ?? 0}，失败 ${
            summary.failed ?? 0
          }`
        : '导入完成';
      setReport(message);
      onImported(message);
    } catch (caught) {
      setError(caught);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Drawer
      title="导入数据"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>关闭</Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            loading={submitting}
            disabled={!file}
          >
            开始导入
          </Button>
        </>
      }
    >
      {error ? <InlineError error={error} /> : null}
      {report ? <div className={styles.noticeOk}>{report}</div> : null}
      <Field label="目标集合" hint="留空时按文件内容创建或复用导入集合。">
        <Select value={target} onChange={(event) => setTarget(event.target.value)}>
          <option value="">自动处理</option>
          {collections.map((item) => (
            <option key={item.collectionId} value={item.collectionId}>
              {item.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label="文件"
        required
        hint="支持 JSONL（每行 q/a）或 CSV（表头 q,a）；最多 10000 行 / 20MB。"
      >
        <input
          className={styles.fileInput}
          type="file"
          accept=".jsonl,.csv,.xlsx,.xls,.txt"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
      </Field>
    </Drawer>
  );
}
