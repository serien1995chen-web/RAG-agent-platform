'use client';

import {
  AttachmentIcon,
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
type SearchSettingTab = 'mode' | 'filter' | 'query';

interface SearchSettings {
  mode: SearchMode;
  tokenBudget: number;
  similarity: number;
  embeddingWeight: number;
  usingRerank: boolean;
  rerankWeight: number;
  rerankCandidateNum: number;
  rerankModelId: string;
  queryOptimizationEnabled: boolean;
  queryOptimizationModelId: string;
  queryOptimizationPrompt: string;
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
  mode: 'semantic',
  tokenBudget: 5_000,
  similarity: 0,
  embeddingWeight: 0.5,
  usingRerank: false,
  rerankWeight: 0.5,
  rerankCandidateNum: 100,
  rerankModelId: '',
  queryOptimizationEnabled: false,
  queryOptimizationModelId: '',
  queryOptimizationPrompt: '',
  tagId: '',
  tagValue: '',
};

const SEARCH_MODES: Array<{ value: SearchMode; label: string; description: string }> = [
  {
    value: 'semantic',
    label: '语义检索',
    description: '使用向量进行文本相关性查询',
  },
  {
    value: 'fulltext',
    label: '全文检索',
    description: '使用传统全文检索，适合查找关键词或主旨特殊的数据',
  },
  {
    value: 'hybrid',
    label: '混合检索',
    description: '结合向量与全文结果，使用 RRF 算法进行排序',
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeSearchSettings(value: Record<string, unknown>): SearchSettings {
  const mode =
    value.mode === 'semantic' || value.mode === 'fulltext' || value.mode === 'hybrid'
      ? value.mode
      : DEFAULT_SETTINGS.mode;
  const integer = (input: unknown, fallback: number) =>
    typeof input === 'number' && Number.isInteger(input) ? input : fallback;
  const finite = (input: unknown, fallback: number) =>
    typeof input === 'number' && Number.isFinite(input) ? input : fallback;
  return {
    ...DEFAULT_SETTINGS,
    ...value,
    mode,
    tokenBudget: integer(value.tokenBudget, DEFAULT_SETTINGS.tokenBudget),
    similarity: finite(value.similarity, DEFAULT_SETTINGS.similarity),
    embeddingWeight: finite(value.embeddingWeight, DEFAULT_SETTINGS.embeddingWeight),
    rerankWeight: finite(value.rerankWeight, DEFAULT_SETTINGS.rerankWeight),
    rerankCandidateNum:
      typeof value.rerankCandidateNum === 'number' &&
      Number.isInteger(value.rerankCandidateNum) &&
      value.rerankCandidateNum >= 10 &&
      value.rerankCandidateNum <= 100
        ? value.rerankCandidateNum
        : DEFAULT_SETTINGS.rerankCandidateNum,
  };
}

function parseSearchHistory(value: unknown): SearchHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is SearchHistoryEntry => {
      if (!isRecord(entry) || !isRecord(entry.result) || !isRecord(entry.settings)) return false;
      return (
        typeof entry.id === 'string' &&
        typeof entry.query === 'string' &&
        typeof entry.createdAt === 'string' &&
        Array.isArray(entry.result.items) &&
        typeof entry.result.searchId === 'string' &&
        !('stopReason' in entry.result)
      );
    })
    .slice(0, 50)
    .map((entry) => ({
      id: entry.id,
      query: entry.query,
      imageLabel: typeof entry.imageLabel === 'string' ? entry.imageLabel : null,
      createdAt: entry.createdAt,
      settings: normalizeSearchSettings(entry.settings as unknown as Record<string, unknown>),
      result: withoutEphemeralImagePreviews(entry.result),
    }));
}

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
  const [settingsTab, setSettingsTab] = useState<SearchSettingTab>('mode');
  const [settingsDraft, setSettingsDraft] = useState<SearchSettings>(DEFAULT_SETTINGS);
  const [settingsError, setSettingsError] = useState('');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState('');
  const [imageUpload, setImageUpload] = useState<KnowledgeFileUploadState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [warning, setWarning] = useState('');
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [resultSettings, setResultSettings] = useState<SearchSettings | null>(null);
  const [selectedHistoryId, setSelectedHistoryId] = useState('');
  const [history, setHistory] = useState<SearchHistoryEntry[]>([]);

  const tagsQuery = useQuery({
    queryKey: ['kb-product', 'tags', props.datasetId],
    queryFn: () => productApi.listTags(props.datasetId),
  });
  const tags = tagsQuery.data ?? [];
  const modelsQuery = useQuery({
    queryKey: ['kb-product', 'models'],
    queryFn: () => productApi.listModels(),
  });
  const models = modelsQuery.data ?? [];
  const rerankModels = models.filter((model) => model.type === 'rerank' && model.authorized);
  const llmModels = models.filter((model) => model.type === 'llm' && model.authorized);
  const selectedTag = tags.find((tag) => tag.id === settings.tagId);
  const selectedHistory = history.find((entry) => entry.id === selectedHistoryId);
  const shownSettings = selectedHistory?.settings ?? resultSettings ?? settings;

  useEffect(() => {
    try {
      const stored = JSON.parse(
        globalThis.localStorage.getItem(historyKey(props.datasetId)) ?? '[]',
      ) as unknown;
      setHistory(parseSearchHistory(stored));
    } catch {
      setHistory([]);
      globalThis.localStorage.removeItem(historyKey(props.datasetId));
    }
    setResult(null);
    setResultSettings(null);
    setSelectedHistoryId('');
    setError(null);
    setWarning('');
  }, [props.datasetId]);

  useEffect(() => {
    try {
      const stored = JSON.parse(
        globalThis.localStorage.getItem(settingsKey(props.datasetId)) ?? 'null',
      ) as unknown;
      setSettings(isRecord(stored) ? normalizeSearchSettings(stored) : DEFAULT_SETTINGS);
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
    if (!modelsQuery.isSuccess || rerankModels.length > 0) return;
    setSettings((current) =>
      current.usingRerank ? { ...current, usingRerank: false, rerankModelId: '' } : current,
    );
  }, [modelsQuery.isSuccess, rerankModels.length]);

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
    const submittedSettings = { ...settings };
    try {
      const filters = buildFilters(selectedTag, settings.tagValue);
      const base = {
        knowledgeSpaceId: props.datasetId,
        query: query.trim(),
        tokenBudget: settings.tokenBudget,
        similarity: settings.similarity,
        embeddingWeight: settings.embeddingWeight,
        usingRerank: settings.usingRerank,
        ...(settings.usingRerank
          ? {
              rerankWeight: settings.rerankWeight,
              rerankCandidateNum: settings.rerankCandidateNum,
              ...(settings.rerankModelId ? { rerankModelId: settings.rerankModelId } : {}),
            }
          : {}),
        queryOptimizationEnabled: settings.queryOptimizationEnabled,
        ...(settings.queryOptimizationEnabled && settings.queryOptimizationModelId
          ? { queryOptimizationModelId: settings.queryOptimizationModelId }
          : {}),
        ...(settings.queryOptimizationEnabled && settings.queryOptimizationPrompt
          ? { queryOptimizationPrompt: settings.queryOptimizationPrompt }
          : {}),
        ...(filters ? { filters } : {}),
      };
      const response = imageUpload?.uploadId
        ? await productApi.searchImage({
            ...base,
            searchMode: 'hybrid',
            imageUploadIds: [imageUpload.uploadId],
          })
        : await productApi.search(settings.mode, {
            ...base,
            searchMode: settings.mode,
          });
      if (response.items.length === 0) {
        const degraded = response.degraded?.length
          ? `降级原因：${response.degraded.join(', ')}。`
          : '';
        setWarning(`搜索结果为空。${degraded}右侧继续保留上一条测试结果。`);
        return;
      }
      setResult(response);
      setResultSettings(submittedSettings);
      setSelectedHistoryId('');
      const entry: SearchHistoryEntry = {
        id: globalThis.crypto.randomUUID(),
        query: query.trim() || '(空查询)',
        imageLabel: imageFile?.name ?? null,
        createdAt: new Date().toISOString(),
        result: withoutEphemeralImagePreviews(response),
        settings: submittedSettings,
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
        purpose: 'image',
        onState: setImageUpload,
      });
    } catch (caught) {
      setError(caught);
    }
  };

  const openSettings = () => {
    setSettingsDraft(settings);
    setSettingsTab('mode');
    setSettingsError('');
    setSettingsOpen(true);
  };

  const applySettings = () => {
    const next = settingsDraft;
    if (
      next.mode === 'hybrid' &&
      (!Number.isFinite(next.embeddingWeight) ||
        next.embeddingWeight < 0.1 ||
        next.embeddingWeight > 0.9)
    ) {
      setSettingsError('混合检索的向量权重必须在 0.1 到 0.9 之间。');
      setSettingsTab('mode');
      return;
    }
    if (
      next.usingRerank &&
      (!Number.isInteger(next.rerankCandidateNum) ||
        next.rerankCandidateNum < 10 ||
        next.rerankCandidateNum > 100)
    ) {
      setSettingsError('重排候选数必须是 10 到 100 之间的整数。');
      setSettingsTab('mode');
      return;
    }
    if (next.queryOptimizationEnabled && !next.queryOptimizationModelId) {
      setSettingsError('开启问题优化后必须选择文本模型。');
      setSettingsTab('query');
      return;
    }
    setSettings({
      ...next,
      usingRerank: next.usingRerank && rerankModels.length > 0,
      rerankModelId: next.usingRerank && rerankModels.length > 0 ? next.rerankModelId : '',
    });
    setSettingsError('');
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
              if (selectedHistoryId === entry.id) {
                setResult(null);
                setResultSettings(null);
                setSelectedHistoryId('');
              }
            }}
          >
            <CloseIcon boxSize={3} />
          </ProductIconButton>
        </div>
      )),
    [history, selectedHistoryId],
  );

  const showSimilarity = shownSettings.usingRerank || shownSettings.mode === 'semantic';

  return (
    <section className="kb2-search-page" aria-label="搜索测试">
      <form className="kb2-search-input-pane" onSubmit={submit}>
        <div className="kb2-search-pane-head">
          <h2>输入测试内容</h2>
          <ProductButton type="button" size="sm" onClick={openSettings}>
            <SettingsIcon boxSize={3.5} />
            搜索配置
          </ProductButton>
        </div>
        <div className="kb2-search-input-card">
          <ProductTextarea
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            rows={7}
            maxLength={20_000}
            placeholder="输入需要测试的内容"
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
            <ProductIconButton label="添加查询图片" onClick={() => fileInput.current?.click()}>
              <AttachmentIcon boxSize={4} />
            </ProductIconButton>
            {imageUpload ? (
              <span className="kb2-search-upload-state" role="status">
                {imageUpload.phase}
              </span>
            ) : null}
          </div>
        </div>
        <ProductButton
          type="submit"
          tone="primary"
          className="kb2-search-submit"
          busy={busy}
          disabled={
            (!query.trim() && !imageUpload?.uploadId) ||
            (Boolean(imageFile) && imageUpload?.phase !== 'completed')
          }
        >
          <SearchIcon boxSize={3.5} />
          {busy ? '测试中' : '测试'}
        </ProductButton>
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
                引用上限 {shownSettings.tokenBudget}
                {showSimilarity ? ` · 最低相关度 ${shownSettings.similarity}` : ''}
                {shownSettings.usingRerank ? ` · 重排候选 ${shownSettings.rerankCandidateNum}` : ''}
                {shownSettings.queryOptimizationEnabled ? ' · 问题优化已开启' : ''}
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
        title="知识库搜索配置"
        size="lg"
        onClose={() => setSettingsOpen(false)}
        footer={
          <>
            <ProductButton onClick={() => setSettingsOpen(false)}>关闭</ProductButton>
            <ProductButton tone="primary" onClick={applySettings}>
              完成
            </ProductButton>
          </>
        }
      >
        <div className="kb2-search-config-tabs" role="tablist" aria-label="搜索配置">
          {[
            ['mode', '搜索方式'],
            ['filter', '搜索过滤'],
            ['query', '问题优化'],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={settingsTab === value}
              onClick={() => {
                setSettingsTab(value as SearchSettingTab);
                setSettingsError('');
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {settingsTab === 'mode' ? (
          <div className="kb2-search-config-panel">
            <div className="kb2-search-mode-cards" role="radiogroup" aria-label="搜索方式">
              {SEARCH_MODES.map((mode) => (
                <label
                  key={mode.value}
                  className={settingsDraft.mode === mode.value ? 'is-selected' : ''}
                >
                  <input
                    type="radio"
                    name="search-mode"
                    value={mode.value}
                    checked={settingsDraft.mode === mode.value}
                    onChange={() =>
                      setSettingsDraft((current) => ({ ...current, mode: mode.value }))
                    }
                  />
                  <span>
                    <strong>{mode.label}</strong>
                    <small>{mode.description}</small>
                  </span>
                </label>
              ))}
            </div>
            {settingsDraft.mode === 'hybrid' ? (
              <div className="kb2-search-weight-row">
                <span>语义 {settingsDraft.embeddingWeight.toFixed(2)}</span>
                <input
                  type="range"
                  min={0.1}
                  max={0.9}
                  step={0.01}
                  value={settingsDraft.embeddingWeight}
                  aria-label="向量权重"
                  onChange={(event) =>
                    setSettingsDraft((current) => ({
                      ...current,
                      embeddingWeight: Number(event.target.value),
                    }))
                  }
                />
                <span>全文 {(1 - settingsDraft.embeddingWeight).toFixed(2)}</span>
              </div>
            ) : null}
            <div className="kb2-search-rerank-block">
              <div className="kb2-search-toggle-row">
                <div>
                  <strong>结果重排</strong>
                  <small>对召回结果进行二次排序，提高相关性。</small>
                </div>
                {rerankModels.length > 0 ? (
                  <label className="kb2-switch">
                    <input
                      type="checkbox"
                      aria-label="结果重排"
                      checked={settingsDraft.usingRerank}
                      onChange={(event) =>
                        setSettingsDraft((current) => ({
                          ...current,
                          usingRerank: event.target.checked,
                        }))
                      }
                    />
                    <span />
                  </label>
                ) : (
                  <span className="kb2-table-muted">未部署重排模型</span>
                )}
              </div>
              {settingsDraft.usingRerank && rerankModels.length > 0 ? (
                <div className="kb2-search-rerank-fields">
                  <ProductField label="重排模型">
                    <ProductSelect
                      value={settingsDraft.rerankModelId}
                      onChange={(event) =>
                        setSettingsDraft((current) => ({
                          ...current,
                          rerankModelId: event.target.value,
                        }))
                      }
                    >
                      <option value="">使用系统默认模型</option>
                      {rerankModels.map((model) => (
                        <option key={model.modelId} value={model.modelId}>
                          {model.displayName}
                        </option>
                      ))}
                    </ProductSelect>
                  </ProductField>
                  <ProductField label="重排候选数">
                    <ProductInput
                      type="number"
                      min={10}
                      max={100}
                      step={10}
                      value={settingsDraft.rerankCandidateNum}
                      onChange={(event) =>
                        setSettingsDraft((current) => ({
                          ...current,
                          rerankCandidateNum: Number(event.target.value),
                        }))
                      }
                    />
                  </ProductField>
                  <ProductField label="重排权重">
                    <ProductInput
                      type="number"
                      min={0.1}
                      max={1}
                      step={0.01}
                      value={settingsDraft.rerankWeight}
                      onChange={(event) =>
                        setSettingsDraft((current) => ({
                          ...current,
                          rerankWeight: Number(event.target.value),
                        }))
                      }
                    />
                  </ProductField>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {settingsTab === 'filter' ? (
          <div className="kb2-search-config-panel kb2-form-grid">
            <ProductField label="引用上限">
              <ProductInput
                type="number"
                min={100}
                max={20_000}
                step={100}
                value={settingsDraft.tokenBudget}
                onChange={(event) =>
                  setSettingsDraft((current) => ({
                    ...current,
                    tokenBudget: Number(event.target.value),
                  }))
                }
              />
            </ProductField>
            <ProductField label="最低相关度">
              {settingsDraft.usingRerank || settingsDraft.mode === 'semantic' ? (
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
              ) : (
                <span className="kb2-table-muted">当前检索方式不支持相关度过滤</span>
              )}
            </ProductField>
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
            {settingsDraft.tagId ? (
              <TagFilterEditor
                tag={tags.find((tag) => tag.id === settingsDraft.tagId)}
                value={settingsDraft.tagValue}
                onChange={(tagValue) => setSettingsDraft((current) => ({ ...current, tagValue }))}
              />
            ) : null}
          </div>
        ) : null}

        {settingsTab === 'query' ? (
          <div className="kb2-search-config-panel">
            <div className="kb2-search-toggle-row">
              <div>
                <strong>问题优化</strong>
                <small>先调用文本模型改写查询，再执行知识库检索。</small>
              </div>
              <label className="kb2-switch">
                <input
                  type="checkbox"
                  aria-label="启用问题优化"
                  checked={settingsDraft.queryOptimizationEnabled}
                  onChange={(event) =>
                    setSettingsDraft((current) => ({
                      ...current,
                      queryOptimizationEnabled: event.target.checked,
                    }))
                  }
                />
                <span />
              </label>
            </div>
            {settingsDraft.queryOptimizationEnabled ? (
              <div className="kb2-search-query-fields">
                <ProductField label="问题优化模型">
                  <ProductSelect
                    value={settingsDraft.queryOptimizationModelId}
                    disabled={llmModels.length === 0}
                    onChange={(event) =>
                      setSettingsDraft((current) => ({
                        ...current,
                        queryOptimizationModelId: event.target.value,
                      }))
                    }
                  >
                    <option value="">
                      {llmModels.length === 0 ? '没有可用的文本模型' : '使用知识库默认模型'}
                    </option>
                    {llmModels.map((model) => (
                      <option key={model.modelId} value={model.modelId}>
                        {model.displayName}
                      </option>
                    ))}
                  </ProductSelect>
                </ProductField>
                <ProductField label="问题优化背景 Prompt">
                  <ProductTextarea
                    value={settingsDraft.queryOptimizationPrompt}
                    rows={6}
                    placeholder="补充业务背景、术语和查询改写约束"
                    onChange={(event) =>
                      setSettingsDraft((current) => ({
                        ...current,
                        queryOptimizationPrompt: event.target.value,
                      }))
                    }
                  />
                </ProductField>
              </div>
            ) : null}
          </div>
        ) : null}
        {settingsError ? (
          <div className="kb2-search-warning" role="alert">
            <WarningIcon boxSize={4} />
            {settingsError}
          </div>
        ) : null}
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
  const [previewFailed, setPreviewFailed] = useState(false);
  const preview = segment.imageBlobRefId ? props.item.imagePreview : undefined;
  const previewExpired = preview ? Date.parse(preview.expiresAt) <= Date.now() : true;
  return (
    <article className="kb2-search-result-card">
      <div className="kb2-search-result-card__head">
        <span>#{props.index + 1}</span>
        <strong title={props.item.citation.title}>{props.item.citation.title}</strong>
        <StatusTag value={props.item.score.toFixed(3)} tone="info" />
      </div>
      {segment.imageBlobRefId ? (
        <figure className="kb2-search-result-image">
          {preview && !previewExpired && !previewFailed ? (
            <img
              src={preview.url}
              alt={props.item.citation.title}
              loading="lazy"
              onError={() => setPreviewFailed(true)}
            />
          ) : (
            <figcaption role="status">图片预览已过期或不可用，请重新测试。</figcaption>
          )}
        </figure>
      ) : null}
      <S7MarkdownRenderer>{content}</S7MarkdownRenderer>
      {segment.answer ? <div className="kb2-search-result-answer">{segment.answer}</div> : null}
      <div className="kb2-search-result-card__footer">
        <span title={segment.knowledgeSpaceId}>知识库 {segment.knowledgeSpaceId}</span>
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

function withoutEphemeralImagePreviews(result: SearchResponse): SearchResponse {
  return {
    ...result,
    items: result.items.map(({ imagePreview: _imagePreview, ...item }) => item),
  };
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
