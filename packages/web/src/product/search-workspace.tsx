'use client';

import {
  CloseIcon,
  ExternalLinkIcon,
  SearchIcon,
  SettingsIcon,
  TimeIcon,
  WarningIcon,
} from '@chakra-ui/icons';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { knowledgeMultipartUpload, type KnowledgeFileUploadState } from '../client/file-upload';
import { S7MarkdownRenderer } from '../components/s7-markdown-renderer';
import { productApi } from './api';
import type { SearchResponse, SearchResultItem, Tag } from './types';
import {
  ProductButton,
  ProductEmpty,
  ProductError,
  ProductField,
  ProductIconButton,
  ProductInput,
  ProductModal,
  ProductSelect,
  ProductTextarea,
  StatusTag,
} from './ui';

type SearchMode = 'semantic' | 'fulltext' | 'hybrid';

interface SearchSettings {
  mode: SearchMode;
  tokenBudget: number;
  similarity: number;
  embeddingWeight: number;
  usingRerank: boolean;
  rerankWeight: number;
  tagId: string;
  tagValue: string;
}

interface SearchHistoryEntry {
  id: string;
  query: string;
  imageLabel: string | null;
  createdAt: string;
  result: SearchResponse;
  settings: SearchSettings;
}

const DEFAULT_SETTINGS: SearchSettings = {
  mode: 'hybrid',
  tokenBudget: 5_000,
  similarity: 0.2,
  embeddingWeight: 0.5,
  usingRerank: false,
  rerankWeight: 0.5,
  tagId: '',
  tagValue: '',
};

export function SearchWorkspace(props: {
  datasetId: string;
  datasetName: string;
  onOpenSegment?: (sourceId: string, segmentId: string) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [settings, setSettings] = useState<SearchSettings>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<SearchSettings>(DEFAULT_SETTINGS);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState('');
  const [imageUpload, setImageUpload] = useState<KnowledgeFileUploadState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [warning, setWarning] = useState('');
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [selectedHistoryId, setSelectedHistoryId] = useState('');
  const [history, setHistory] = useState<SearchHistoryEntry[]>([]);

  const tagsQuery = useQuery({
    queryKey: ['kb-product', 'tags', props.datasetId],
    queryFn: () => productApi.listTags(props.datasetId),
  });
  const tags = tagsQuery.data ?? [];
  const selectedTag = tags.find((tag) => tag.id === settings.tagId);

  useEffect(() => {
    try {
      const stored = JSON.parse(
        globalThis.localStorage.getItem(historyKey(props.datasetId)) ?? '[]',
      ) as SearchHistoryEntry[];
      setHistory(Array.isArray(stored) ? stored.slice(0, 50) : []);
    } catch {
      setHistory([]);
    }
    setResult(null);
    setSelectedHistoryId('');
    setError(null);
    setWarning('');
  }, [props.datasetId]);

  useEffect(() => {
    try {
      const stored = JSON.parse(
        globalThis.localStorage.getItem(settingsKey(props.datasetId)) ?? 'null',
      ) as SearchSettings | null;
      setSettings(stored ? { ...DEFAULT_SETTINGS, ...stored } : DEFAULT_SETTINGS);
    } catch {
      setSettings(DEFAULT_SETTINGS);
    } finally {
      setSettingsLoaded(true);
    }
  }, [props.datasetId]);

  useEffect(() => {
    if (!settingsLoaded) return;
    globalThis.localStorage.setItem(settingsKey(props.datasetId), JSON.stringify(settings));
  }, [props.datasetId, settings, settingsLoaded]);

  useEffect(() => {
    globalThis.localStorage.setItem(
      historyKey(props.datasetId),
      JSON.stringify(history.slice(0, 50)),
    );
  }, [history, props.datasetId]);

  useEffect(() => {
    return () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [imageUrl]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setWarning('');
    try {
      const filters = buildFilters(selectedTag, settings.tagValue);
      const base = {
        knowledgeSpaceId: props.datasetId,
        query: query.trim(),
        tokenBudget: settings.tokenBudget,
        similarity: settings.similarity,
        searchMode: settings.mode,
        embeddingWeight: settings.embeddingWeight,
        usingRerank: settings.usingRerank,
        rerankWeight: settings.rerankWeight,
        ...(filters ? { filters } : {}),
      };
      const response = imageUpload?.uploadId
        ? await productApi.searchImage({
            ...base,
            imageUploadIds: [imageUpload.uploadId],
          })
        : await productApi.search(settings.mode, base);
      if (response.items.length === 0) {
        setWarning('搜索结果为空。右侧继续保留上一条测试结果。');
        return;
      }
      setResult(response);
      setSelectedHistoryId('');
      const entry: SearchHistoryEntry = {
        id: globalThis.crypto.randomUUID(),
        query: query.trim() || '(空查询)',
        imageLabel: imageFile?.name ?? null,
        createdAt: new Date().toISOString(),
        result: response,
        settings,
      };
      setHistory((current) => [entry, ...current].slice(0, 50));
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const uploadImage = async (file: File | null) => {
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    setImageFile(file);
    setImageUrl(file ? URL.createObjectURL(file) : '');
    setImageUpload(null);
    setError(null);
    if (!file) return;
    try {
      await knowledgeMultipartUpload(file, {
        knowledgeSpaceId: props.datasetId,
        onState: setImageUpload,
      });
    } catch (caught) {
      setError(caught);
    }
  };

  const openSettings = () => {
    setSettingsDraft(settings);
    setSettingsOpen(true);
  };

  const applySettings = () => {
    setSettings(settingsDraft);
    setSettingsOpen(false);
  };

  const historyList = useMemo(
    () =>
      history.map((entry) => (
        <div
          key={entry.id}
          className={`kb2-search-history${selectedHistoryId === entry.id ? ' is-selected' : ''}`}
        >
          <button
            type="button"
            onClick={() => {
              setSelectedHistoryId(entry.id);
              setResult(entry.result);
              setWarning('');
            }}
          >
            <strong>
              {entry.query}
              {entry.imageLabel ? ' [图片]' : ''}
            </strong>
            <span>
              {formatTime(entry.createdAt)} · {entry.result.durationMs} ms
            </span>
          </button>
          <ProductIconButton
            label="删除测试历史"
            onClick={(event) => {
              event.stopPropagation();
              setHistory((current) => current.filter((item) => item.id !== entry.id));
              if (selectedHistoryId === entry.id) setResult(null);
            }}
          >
            <CloseIcon boxSize={3} />
          </ProductIconButton>
        </div>
      )),
    [history, selectedHistoryId],
  );

  return (
    <section className="kb2-search-page" aria-label="搜索测试">
      <form className="kb2-search-input-pane" onSubmit={submit}>
        <div className="kb2-search-pane-head">
          <div>
            <h2>搜索测试</h2>
            <p>测试当前知识库的召回与引用结果。</p>
          </div>
          <ProductButton type="button" size="sm" onClick={openSettings}>
            <SettingsIcon boxSize={3.5} />
            参数
          </ProductButton>
        </div>
        <ProductTextarea
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          rows={7}
          placeholder="输入要测试的问题"
          aria-label="测试查询"
        />
        <div className="kb2-search-attachments">
          {imageUrl ? (
            <div className="kb2-search-image-preview">
              <img src={imageUrl} alt={imageFile?.name ?? '查询图片'} />
              <ProductIconButton label="移除查询图片" onClick={() => void uploadImage(null)}>
                <CloseIcon boxSize={3} />
              </ProductIconButton>
            </div>
          ) : null}
          <input
            ref={fileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            hidden
            onChange={(event) => void uploadImage(event.target.files?.[0] ?? null)}
          />
          <ProductButton type="button" size="sm" onClick={() => fileInput.current?.click()}>
            图片查询
          </ProductButton>
          {imageUpload ? (
            <span className="kb2-table-muted">
              {imageUpload.phase} · {imageUpload.progress}%
            </span>
          ) : null}
        </div>
        <div className="kb2-search-actions">
          <span>
            {modeLabel(settings.mode)} · Token {settings.tokenBudget} · 相似度 {settings.similarity}
          </span>
          <ProductButton
            type="submit"
            tone="primary"
            busy={busy}
            disabled={
              (!query.trim() && !imageUpload?.uploadId) ||
              (Boolean(imageFile) && imageUpload?.phase !== 'completed')
            }
          >
            <SearchIcon boxSize={3.5} />
            开始测试
          </ProductButton>
        </div>
        <ProductError error={error} />
        {warning ? (
          <div className="kb2-search-warning" role="status">
            <WarningIcon boxSize={4} />
            {warning}
          </div>
        ) : null}
        <div className="kb2-search-history-wrap">
          <h3>
            <TimeIcon boxSize={3.5} />
            测试历史
          </h3>
          {historyList.length ? historyList : <div className="kb2-table-muted">暂无测试历史</div>}
        </div>
      </form>

      <div className="kb2-search-results-pane">
        {result ? (
          <>
            <div className="kb2-search-results-head">
              <div>
                <h2>
                  测试结果 <span>({result.durationMs} ms)</span>
                </h2>
                <p>
                  {modeLabel(result.mode)} · 返回 {result.items.length} 条
                  {result.partial ? ' · 部分结果' : ''}
                </p>
              </div>
              {result.degraded?.length ? (
                <StatusTag value={`降级：${result.degraded.join(', ')}`} tone="warning" />
              ) : null}
            </div>
            <div className="kb2-search-params">
              <StatusTag value={modeLabel(result.mode)} tone="info" />
              <span>测试参数</span>
              <small>
                Token {settings.tokenBudget} · 相似度 {settings.similarity}
              </small>
            </div>
            <div className="kb2-search-result-list">
              {result.items.map((item, index) => (
                <SearchResultCard
                  key={`${item.citation.citationId}-${index}`}
                  item={item}
                  index={index}
                  onOpenSegment={props.onOpenSegment}
                />
              ))}
            </div>
          </>
        ) : (
          <ProductEmpty
            title="测试结果将在这里展示"
            description="输入问题或添加查询图片后开始测试。"
          />
        )}
      </div>

      <ProductModal
        open={settingsOpen}
        title="搜索参数"
        size="lg"
        onClose={() => setSettingsOpen(false)}
        footer={
          <>
            <ProductButton onClick={() => setSettingsOpen(false)}>取消</ProductButton>
            <ProductButton tone="primary" onClick={applySettings}>
              完成
            </ProductButton>
          </>
        }
      >
        <div className="kb2-form-grid">
          <ProductField label="检索模式">
            <ProductSelect
              value={settingsDraft.mode}
              onChange={(event) =>
                setSettingsDraft((current) => ({
                  ...current,
                  mode: event.target.value as SearchMode,
                }))
              }
            >
              <option value="semantic">语义检索</option>
              <option value="fulltext">全文检索</option>
              <option value="hybrid">混合检索</option>
            </ProductSelect>
          </ProductField>
          <ProductField label="Token 上限">
            <ProductInput
              type="number"
              min={1}
              max={20000}
              value={settingsDraft.tokenBudget}
              onChange={(event) =>
                setSettingsDraft((current) => ({
                  ...current,
                  tokenBudget: Number(event.target.value) || 1,
                }))
              }
            />
          </ProductField>
          <ProductField label="最低相似度">
            <ProductInput
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={settingsDraft.similarity}
              onChange={(event) =>
                setSettingsDraft((current) => ({
                  ...current,
                  similarity: Number(event.target.value),
                }))
              }
            />
          </ProductField>
          {settingsDraft.mode === 'hybrid' ? (
            <ProductField label="向量权重">
              <ProductInput
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={settingsDraft.embeddingWeight}
                onChange={(event) =>
                  setSettingsDraft((current) => ({
                    ...current,
                    embeddingWeight: Number(event.target.value),
                  }))
                }
              />
            </ProductField>
          ) : null}
          <div className="kb2-form-grid__full">
            <label className="kb2-checkbox-row">
              <input
                type="checkbox"
                checked={settingsDraft.usingRerank}
                onChange={(event) =>
                  setSettingsDraft((current) => ({
                    ...current,
                    usingRerank: event.target.checked,
                  }))
                }
              />
              <span>启用 ReRank</span>
            </label>
          </div>
          {settingsDraft.usingRerank ? (
            <ProductField label="ReRank 权重">
              <ProductInput
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={settingsDraft.rerankWeight}
                onChange={(event) =>
                  setSettingsDraft((current) => ({
                    ...current,
                    rerankWeight: Number(event.target.value),
                  }))
                }
              />
            </ProductField>
          ) : null}
          <ProductField label="标签过滤">
            <ProductSelect
              value={settingsDraft.tagId}
              onChange={(event) =>
                setSettingsDraft((current) => ({
                  ...current,
                  tagId: event.target.value,
                  tagValue: '',
                }))
              }
            >
              <option value="">不过滤</option>
              {tags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.label}
                </option>
              ))}
            </ProductSelect>
          </ProductField>
        </div>
        {settingsDraft.tagId ? (
          <TagFilterEditor
            tag={tags.find((tag) => tag.id === settingsDraft.tagId)}
            value={settingsDraft.tagValue}
            onChange={(tagValue) => setSettingsDraft((current) => ({ ...current, tagValue }))}
          />
        ) : null}
        <div className="kb2-note">
          当前合同未提供查询扩展 Prompt 和重排模型选择字段；对应配置未伪造。
        </div>
      </ProductModal>
    </section>
  );
}

function TagFilterEditor(props: { tag?: Tag; value: string; onChange: (value: string) => void }) {
  if (!props.tag) return null;
  if (props.tag.options?.length) {
    return (
      <ProductField label="标签值">
        <ProductSelect value={props.value} onChange={(event) => props.onChange(event.target.value)}>
          <option value="">请选择</option>
          {props.tag.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </ProductSelect>
      </ProductField>
    );
  }
  return (
    <ProductField label="标签值">
      <ProductInput
        type={props.tag.tagType === 'number' ? 'number' : 'text'}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </ProductField>
  );
}

function SearchResultCard(props: {
  item: SearchResultItem;
  index: number;
  onOpenSegment?: (sourceId: string, segmentId: string) => void;
}) {
  const segment = props.item.segment;
  const content = segment.question || segment.content;
  return (
    <article className="kb2-search-result-card">
      <div className="kb2-search-result-card__head">
        <span>#{props.index + 1}</span>
        <strong title={props.item.citation.title}>{props.item.citation.title}</strong>
        <StatusTag value={props.item.score.toFixed(3)} tone="info" />
      </div>
      <S7MarkdownRenderer>{content}</S7MarkdownRenderer>
      {segment.answer ? <div className="kb2-search-result-answer">{segment.answer}</div> : null}
      <div className="kb2-search-result-card__footer">
        <span>
          来源 {segment.sourceId.slice(-6)} · 数据版本 {segment.version}
        </span>
        <div className="kb2-inline-actions">
          {props.item.citation.sourceUrl ? (
            <a href={props.item.citation.sourceUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLinkIcon boxSize={3.5} /> 原始来源
            </a>
          ) : null}
          {props.onOpenSegment ? (
            <ProductButton
              size="sm"
              onClick={() => props.onOpenSegment?.(segment.sourceId, segment.id)}
            >
              查看数据
            </ProductButton>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function historyKey(datasetId: string) {
  return `kb-product-search-history:${datasetId}`;
}

function settingsKey(datasetId: string) {
  return `kb-product-search-settings:${datasetId}`;
}

function modeLabel(mode: string) {
  if (mode === 'semantic') return '语义检索';
  if (mode === 'fulltext' || mode === 'full-text') return '全文检索';
  if (mode === 'hybrid') return '混合检索';
  if (mode === 'image') return '图片检索';
  if (mode === 'multi_space') return '多知识库检索';
  return mode;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function buildFilters(tag: Tag | undefined, value: string) {
  if (!tag || !value) return undefined;
  const operator = tag.tagType === 'string' ? '$contains' : tag.tagType === 'array' ? '$is' : '$eq';
  const resolved =
    tag.tagType === 'number'
      ? Number(value)
      : tag.tagType === 'datetime'
        ? Date.parse(value)
        : tag.tagType === 'array'
          ? [value]
          : value;
  return {
    logic: 'AND',
    conditions: [
      {
        tagId: tag.id,
        tagType: tag.tagType,
        operator,
        value: resolved,
      },
    ],
  };
}
