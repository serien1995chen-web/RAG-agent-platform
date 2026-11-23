'use client';

import { AttachmentIcon, CheckIcon } from '@chakra-ui/icons';
import { useEffect, useRef, useState } from 'react';
import { importBackup, importImageDataset, importTemplate, createSource } from './api';
import type { Job } from './types';
import {
  ProductButton,
  ProductError,
  ProductField,
  ProductInput,
  ProductModal,
  useProductToast,
} from './ui';
import { knowledgeMultipartUpload } from '../client/file-upload';

export type TextImportSource = 'fileLocal' | 'fileLink' | 'fileCustom';
export type StructuredImportKind = 'template' | 'backup';

const TEXT_SOURCE_OPTIONS: Array<{
  value: TextImportSource;
  title: string;
  description: string;
}> = [
  {
    value: 'fileLocal',
    title: '本地文件',
    description: '上传 PDF、TXT、DOCX 等格式的文件',
  },
  {
    value: 'fileLink',
    title: '网页链接',
    description: '读取静态网页内容作为数据集',
  },
  {
    value: 'fileCustom',
    title: '自定义文本',
    description: '手动输入一段文本作为数据集',
  },
];

export function TextSourceDialog(props: {
  open: boolean;
  onClose: () => void;
  onChoose: (source: TextImportSource) => void;
}) {
  const [source, setSource] = useState<TextImportSource>('fileLocal');

  useEffect(() => {
    if (props.open) setSource('fileLocal');
  }, [props.open]);

  return (
    <ProductModal
      open={props.open}
      title="选择来源"
      size="md"
      onClose={props.onClose}
      footer={
        <>
          <ProductButton onClick={props.onClose}>取消</ProductButton>
          <ProductButton
            tone="primary"
            onClick={() => {
              props.onChoose(source);
              props.onClose();
            }}
          >
            确认
          </ProductButton>
        </>
      }
    >
      <fieldset className="kb2-source-choice-list">
        <legend className="kb2-visually-hidden">文本数据集来源</legend>
        {TEXT_SOURCE_OPTIONS.map((option) => (
          <label
            className={`kb2-source-choice${source === option.value ? ' is-selected' : ''}`}
            key={option.value}
          >
            <input
              type="radio"
              name="text-import-source"
              value={option.value}
              checked={source === option.value}
              onChange={() => setSource(option.value)}
            />
            <span className="kb2-source-choice__icon">
              {source === option.value ? <CheckIcon /> : <AttachmentIcon />}
            </span>
            <span>
              <strong>{option.title}</strong>
              <small>{option.description}</small>
            </span>
          </label>
        ))}
      </fieldset>
    </ProductModal>
  );
}

export function EmptySourceDialog(props: {
  open: boolean;
  spaceId: string;
  directoryId?: string;
  onClose: () => void;
  onCompleted: () => void;
}) {
  const toast = useProductToast();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!props.open) return;
    setName('');
    setError(null);
    window.setTimeout(() => inputRef.current?.focus(), 60);
  }, [props.open]);

  const submit = async () => {
    if (!name.trim()) {
      setError(new Error('请输入空白数据集名称'));
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createSource(props.spaceId, {
        name: name.trim(),
        kind: 'text',
        directoryId: props.directoryId || null,
      });
      toast.success('空白数据集已创建');
      props.onCompleted();
      props.onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ProductModal
      open={props.open}
      title="创建手动数据集"
      description="手动数据集允许创建一个空的容器装入数据"
      size="sm"
      onClose={() => !busy && props.onClose()}
      footer={
        <>
          <ProductButton disabled={busy} onClick={props.onClose}>
            取消
          </ProductButton>
          <ProductButton tone="primary" busy={busy} onClick={() => void submit()}>
            确认
          </ProductButton>
        </>
      }
    >
      <ProductField label="名称">
        <ProductInput
          ref={inputRef}
          value={name}
          maxLength={240}
          placeholder="请输入名称"
          onChange={(event) => setName(event.target.value)}
        />
      </ProductField>
      <ProductError error={error} />
    </ProductModal>
  );
}

export function StructuredImportDialog(props: {
  open: boolean;
  kind: StructuredImportKind;
  spaceId: string;
  directoryId?: string;
  onClose: () => void;
  onCompleted: (job: Job) => void;
}) {
  const toast = useProductToast();
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!props.open) return;
    setFile(null);
    setProgress(0);
    setError(null);
  }, [props.kind, props.open]);

  const title = props.kind === 'template' ? '模版导入' : '备份导入';
  const submit = async () => {
    if (!file) {
      setError(new Error('请选择文件'));
      fileInputRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    let uploadId = '';
    try {
      await knowledgeMultipartUpload(file, {
        knowledgeSpaceId: props.spaceId,
        onState: (state) => {
          if (state.uploadId) uploadId = state.uploadId;
          setProgress(state.progress);
          if (state.error) setError(state.error);
        },
      });
      if (!uploadId) throw new Error('上传完成但未返回 uploadId');
      const job =
        props.kind === 'template'
          ? await importTemplate(props.spaceId, {
              uploadId,
              directoryId: props.directoryId || null,
            })
          : await importBackup(props.spaceId, {
              uploadId,
              directoryId: props.directoryId || null,
              dryRun: false,
              conflictStrategy: 'fail',
            });
      toast.success('导入任务已提交');
      props.onCompleted(job);
      props.onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const chooseFile = (next: File | null) => {
    setError(null);
    if (!next) {
      setFile(null);
      return;
    }
    if (!/\.(csv|xlsx)$/i.test(next.name)) {
      setFile(null);
      setError(new Error('仅支持 CSV 或 XLSX 文件'));
      return;
    }
    if (next.size > 50 * 1024 * 1024) {
      setFile(null);
      setError(new Error('单个文件不能超过 50 MB'));
      return;
    }
    setFile(next);
  };

  return (
    <ProductModal
      open={props.open}
      title={title}
      description={
        props.kind === 'template'
          ? '按模版文件上传问答数据'
          : '将知识库导出的 CSV 或 XLSX 文件重新导入'
      }
      size="md"
      onClose={() => !busy && props.onClose()}
      footer={
        <>
          <ProductButton disabled={busy} onClick={props.onClose}>
            取消
          </ProductButton>
          <ProductButton tone="primary" busy={busy} disabled={!file} onClick={() => void submit()}>
            {busy ? `上传中 ${progress}%` : '确认导入'}
          </ProductButton>
        </>
      }
    >
      {props.kind === 'template' ? (
        <ProductButton
          size="sm"
          onClick={() => {
            const csv = [
              'q,a,index,index,metadata',
              '"Who are you?","I am an AI assistant.","identity","assistant","{""source"":""template""}"',
              '"What can you do?","I can answer questions from imported knowledge.","help","faq","{""source"":""template""}"',
            ].join('\r\n');
            const url = URL.createObjectURL(
              new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' }),
            );
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = 'template.csv';
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            URL.revokeObjectURL(url);
          }}
        >
          下载 CSV 模板
        </ProductButton>
      ) : null}
      <label className="kb2-upload-zone kb2-structured-upload">
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.xlsx"
          multiple={false}
          onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
          disabled={busy}
        />
        <AttachmentIcon boxSize={7} />
        <strong>{file ? file.name : '点击或拖动文件到此处上传'}</strong>
        <span>
          {file
            ? `${Math.max(1, Math.round(file.size / 1024))} KB · 已达到最大文件数量`
            : '支持 CSV、XLSX，单次最多 1 个文件，单文件不超过 50 MB'}
        </span>
        {busy ? (
          <span className="kb2-progress-track">
            <span style={{ width: `${progress}%` }} />
          </span>
        ) : null}
      </label>
      <ProductError error={error} />
    </ProductModal>
  );
}

export function ImageDatasetDialog(props: {
  open: boolean;
  spaceId: string;
  directoryId?: string;
  onClose: () => void;
  onCompleted: (job: Job) => void;
}) {
  const toast = useProductToast();
  const [name, setName] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!props.open) return;
    setName('');
    setFiles([]);
    setProgress(0);
    setError(null);
    window.setTimeout(() => nameRef.current?.focus(), 60);
  }, [props.open]);

  const chooseFiles = (input: FileList | null) => {
    const next = Array.from(input ?? []);
    setError(null);
    if (next.length > 5) {
      setFiles([]);
      setError(new Error('单次最多上传 5 张图片'));
      return;
    }
    const unsupported = next.find(
      (file) => !['image/jpeg', 'image/png'].includes(file.type.toLowerCase()),
    );
    if (unsupported) {
      setFiles([]);
      setError(new Error('仅支持 JPG、JPEG 或 PNG 图片'));
      return;
    }
    const oversized = next.find((file) => file.size > 50 * 1024 * 1024);
    if (oversized) {
      setFiles([]);
      setError(new Error('单张图片不能超过 50 MB'));
      return;
    }
    setFiles(next);
  };

  const submit = async () => {
    if (!name.trim()) {
      setError(new Error('请输入数据集名称'));
      nameRef.current?.focus();
      return;
    }
    if (files.length === 0) {
      setError(new Error('请选择图片'));
      fileInputRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    const uploadIds: string[] = [];
    try {
      for (const [index, file] of files.entries()) {
        let uploadId = '';
        await knowledgeMultipartUpload(file, {
          knowledgeSpaceId: props.spaceId,
          onState: (state) => {
            if (state.uploadId) uploadId = state.uploadId;
            const completed = index + state.progress / 100;
            setProgress(Math.round((completed / files.length) * 100));
            if (state.error) setError(state.error);
          },
        });
        if (!uploadId) throw new Error('图片上传完成但未返回 uploadId');
        uploadIds.push(uploadId);
      }
      const job = await importImageDataset(props.spaceId, {
        name: name.trim(),
        uploadIds,
        directoryId: props.directoryId || null,
      });
      toast.success('图片数据集创建任务已提交');
      props.onCompleted(job);
      props.onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ProductModal
      open={props.open}
      title="创建图片数据集"
      size="md"
      onClose={() => !busy && props.onClose()}
      footer={
        <>
          <ProductButton disabled={busy} onClick={props.onClose}>
            关闭
          </ProductButton>
          <ProductButton
            tone="primary"
            busy={busy}
            disabled={!name.trim() || files.length === 0}
            onClick={() => void submit()}
          >
            {busy
              ? `上传中: ${progress}%`
              : files.length > 0
                ? `共 ${files.length} 张图片 | 确认创建`
                : '确认创建'}
          </ProductButton>
        </>
      }
    >
      <div className="kb2-form-stack">
        <ProductField label="数据集名称">
          <ProductInput
            ref={nameRef}
            value={name}
            maxLength={240}
            placeholder="请输入数据集名称"
            onChange={(event) => setName(event.target.value)}
          />
        </ProductField>
        <ProductField label="数据集内容">
          <label className="kb2-upload-zone">
            <input
              ref={fileInputRef}
              type="file"
              aria-label="数据集内容"
              accept=".jpg,.jpeg,.png,image/jpeg,image/png"
              multiple
              onChange={(event) => chooseFiles(event.target.files)}
              disabled={busy}
            />
            <AttachmentIcon boxSize={7} />
            <strong>{files.length > 0 ? `已选择 ${files.length} 张图片` : '选择图片'}</strong>
            <span>支持 JPG、JPEG、PNG，单次最多 5 张，单张不超过 50 MB</span>
          </label>
          {files.length > 0 ? (
            <div className="kb2-upload-list">
              {files.map((file) => (
                <div className="kb2-upload-row" key={`${file.name}:${file.lastModified}`}>
                  <span>
                    <strong>{file.name}</strong>
                    <small>{Math.max(1, Math.round(file.size / 1024))} KB</small>
                  </span>
                  <span />
                  <span className="kb2-table-muted">等待上传</span>
                </div>
              ))}
            </div>
          ) : null}
        </ProductField>
        <ProductError error={error} />
      </div>
    </ProductModal>
  );
}
