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
import { S8SearchFormSchema } from '../forms/s8-search-form';
import { productApi } from './api';
import type { DeepSearchResponse, SearchResponse, SearchResultItem, Tag } from './types';
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

type SearchMode = 'semantic' | 'fulltext' | 'hybrid' | 'deep';
type SearchWorkspaceResult = SearchResponse | DeepSearchResponse;

interface SearchSettings {
  mode: SearchMode;
  tokenBudget: number;
  similarity: number;
  embeddingWeight: number;
  usingRerank: boolean;
  rerankWeight: number;
  rerankModelId: string;
  queryOptimizationEnabled: boolean;
  queryOptimizationModelId: string;
  queryOptimizationPrompt: string;
  tagId: string;
  tagValue: string;
  deepMaxRounds: number;
  deepRoundTokenBudget: number;
  deepTokenBudget: number;
  deepCostBudgetPoints?: number;
  stopWhenNoNewEvidence: boolean;
}

interface SearchHistoryEntry {
  id: string;
  query: string;
  imageLabel: string | null;
  createdAt: string;
  result: SearchWorkspaceResult;
  settings: SearchSettings;
}

const DEFAULT_SETTINGS: SearchSettings = {
  mode: 'hybrid',
  tokenBudget: 5_000,
  similarity: 0.2,
  embeddingWeight: 0.5,
  usingRerank: false,
  rerankWeight: 0.5,
  rerankModelId: '',
  queryOptimizationEnabled: false,
  queryOptimizationModelId: '',
  queryOptimizationPrompt: '',
  tagId: '',
  tagValue: '',
  deepMaxRounds: 3,
  deepRoundTokenBudget: 5_000,
  deepTokenBudget: 12_000,
  stopWhenNoNewEvidence: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeSearchSettings(value: Record<string, unknown>): SearchSettings {
  const mode =
    value.mode === 'semantic' ||
    value.mode === 'fulltext' ||
    value.mode === 'hybrid' ||
    value.mode === 'deep'
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
    deepMaxRounds: integer(value.deepMaxRounds, DEFAULT_SETTINGS.deepMaxRounds),
    deepRoundTokenBudget: integer(
      value.deepRoundTokenBudget,
      DEFAULT_SETTINGS.deepRoundTokenBudget,
    ),
    deepTokenBudget: integer(value.deepTokenBudget, DEFAULT_SETTINGS.deepTokenBudget),
    deepCostBudgetPoints:
      typeof value.deepCostBudgetPoints === 'number' &&
      Number.isFinite(value.deepCostBudgetPoints) &&
      value.deepCostBudgetPoints > 0
        ? value.deepCostBudgetPoints
        : undefined,
    stopWhenNoNewEvidence:
      typeof value.stopWhenNoNewEvidence === 'boolean'
        ? value.stopWhenNoNewEvidence
        : DEFAULT_SETTINGS.stopWhenNoNewEvidence,
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
        (!('stopReason' in entry.result) ||
          (entry.result.mode === 'multi_space' &&
            Array.isArray(entry.result.rounds) &&
            isRecord(entry.result.usage)))
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
  const [settingsDraft, setSettingsDraft] = useState<SearchSettings>(DEFAULT_SETTINGS);
  const [settingsError, setSettingsError] = useState('');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState('');
  const [imageUpload, setImageUpload] = useState<KnowledgeFileUploadState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [warning, setWarning] = useState('');
  const [result, setResult] = useState<SearchWorkspaceResult | null>(null);
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
        embeddingWeight: settings.embeddingWeight,
        usingRerank: settings.usingRerank,
        rerankWeight: settings.rerankWeight,
        ...(settings.rerankModelId ? { rerankModelId: settings.rerankModelId } : {}),
        queryOptimizationEnabled: settings.queryOptimizationEnabled,
        ...(settings.queryOptimizationModelId
          ? { queryOptimizationModelId: settings.queryOptimizationModelId }
          : {}),
        ...(settings.queryOptimizationPrompt
          ? { queryOptimizationPrompt: settings.queryOptimizationPrompt }
          : {}),
        ...(filters ? { filters } : {}),
      };
      const response: SearchWorkspaceResult =
        settings.mode === 'deep'
          ? await productApi.searchDeep({
              ...base,
              knowledgeSpaceIds: [props.datasetId],
              tokenBudget: settings.deepTokenBudget,
              roundTokenBudget: settings.deepRoundTokenBudget,
              maxRounds: settings.deepMaxRounds,
              stopWhenNoNewEvidence: settings.stopWhenNoNewEvidence,
              searchMode: 'hybrid',
              ...(settings.deepCostBudgetPoints === undefined
                ? {}
                : { costBudgetPoints: settings.deepCostBudgetPoints }),
            })
          : imageUpload?.uploadId
            ? await productApi.searchImage({
                ...base,
                searchMode: settings.mode,
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
        const stopReason = 'stopReason' in response ? `停止原因：${response.stopReason}。` : '';
        setWarning(`搜索结果为空。${stopReason}${degraded}右侧继续保留上一条测试结果。`);
        return;
      }
      setResult(response);
      setSelectedHistoryId('');
      const entry: SearchHistoryEntry = {
        id: globalThis.crypto.randomUUID(),
        query: query.trim() || '(空查询)',
        imageLabel: imageFile?.name ?? null,
        createdAt: new Date().toISOString(),
        result: withoutEphemeralImagePreviews(response),
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
        purpose: 'image',
        onState: setImageUpload,
      });
    } catch (caught) {
      setError(caught);
    }
  };

  const openSettings = () => {
    setSettingsDraft(settings);
    setSettingsError('');
    setSettingsOpen(true);
  };

  const applySettings = () => {
    if (settingsDraft.mode === 'deep') {
      const validation = S8SearchFormSchema.safeParse({
        knowledgeSpaceId: props.datasetId,
        knowledgeSpaceIds: [props.datasetId],
        query: 'validation',
        tokenBudget: settingsDraft.deepTokenBudget,
        roundTokenBudget: settingsDraft.deepRoundTokenBudget,
        maxRounds: settingsDraft.deepMaxRounds,
        stopWhenNoNewEvidence: settingsDraft.stopWhenNoNewEvidence,
        similarity: settingsDraft.similarity,
        embeddingWeight: settingsDraft.embeddingWeight,
        usingRerank: settingsDraft.usingRerank,
        rerankWeight: settingsDraft.rerankWeight,
        imageUploadIds: [],
        ...(settingsDraft.deepCostBudgetPoints === undefined
          ? {}
          : { costBudgetPoints: settingsDraft.deepCostBudgetPoints }),
      });
      if (!validation.success) {
        const path = validation.error.issues[0]?.path.join('.') ?? '';
        const hints: Record<string, string> = {
          maxRounds: '最大轮次必须在 1 到 3 之间。',
          roundTokenBudget: '单轮 token 预算必须在 500 到 20000 之间。',
          tokenBudget: '总 token 预算必须在 500 到 20000 之间。',
          costBudgetPoints: 'AI Points 预算必须为可安全结算的正数。',
        };
        setSettingsError(hints[path] ?? 'Deep 搜索参数校验失败，请检查输入。');
        return;
      }
    }
    setSettings(settingsDraft);
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
        <fieldset className="kb2-search-mode-switch" aria-label="切换搜索模式">
          <legend>切换搜索模式</legend>
          {[
            ['semantic', '语义检索'],
            ['fulltext', '全文检索'],
            ['hybrid', '混合检索'],
            ['deep', 'Deep RAG 深度检索'],
          ].map(([value, label]) => (
            <label key={value} className="kb2-checkbox-row">
              <input
                type="radio"
                name="search-mode"
                value={value}
                checked={settings.mode === value}
                onChange={() => {
                  setSettings((current) => ({ ...current, mode: value as SearchMode }));
                  setError(null);
                  setWarning('');
                }}
              />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
        <ProductTextarea
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          rows={7}
          maxLength={20_000}
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
          <ProductButton
            type="button"
            size="sm"
            onClick={() => fileInput.current?.click()}
            disabled={settings.mode === 'deep'}
          >
            图片查询
          </ProductButton>
          {settings.mode === 'deep' ? (
            <span className="kb2-table-muted">Deep RAG 仅支持文本查询</span>
          ) : null}
          {imageUpload ? (
            <span className="kb2-table-muted">
              {imageUpload.phase} · {imageUpload.progress}%
            </span>
          ) : null}
        </div>
        <div className="kb2-search-actions">
          <span>
            {settings.mode === 'deep'
              ? `Deep RAG 深度检索 · 总 token ${settings.deepTokenBudget} · 单轮 token ${settings.deepRoundTokenBudget} · 最大轮次 ${settings.deepMaxRounds}`
              : `${modeLabel(settings.mode)} · Token ${settings.tokenBudget} · 相似度 ${settings.similarity}`}
          </span>
          <ProductButton
            type="submit"
            tone="primary"
            busy={busy}
            disabled={
              settings.mode === 'deep'
                ? !query.trim()
                : (!query.trim() && !imageUpload?.uploadId) ||
                  (Boolean(imageFile) && imageUpload?.phase !== 'completed')
            }
          >
            <SearchIcon boxSize={3.5} />
            {busy ? '测试中' : '开始测试'}
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
                  {'stopReason' in result ? 'Deep RAG 深度检索' : modeLabel(result.mode)} · 返回{' '}
                  {result.items.length} 条{result.partial ? ' · 部分结果' : ''}
                </p>
              </div>
              {result.degraded?.length ? (
                <StatusTag value={`降级：${result.degraded.join(', ')}`} tone="warning" />
              ) : null}
            </div>
            <div className="kb2-search-params">
              <StatusTag
                value={'stopReason' in result ? 'Deep RAG 深度检索' : modeLabel(result.mode)}
                tone="info"
              />
              <span>测试参数</span>
              <small>
                {'stopReason' in result
                  ? `总 token ${settings.deepTokenBudget} · 单轮 token ${settings.deepRoundTokenBudget} · 最大轮次 ${settings.deepMaxRounds}`
                  : `Token ${settings.tokenBudget} · 相似度 ${settings.similarity}`}
              </small>
            </div>
            {'stopReason' in result ? (
              <div className="kb2-search-deep-summary">
                <div>
                  <span>停止原因</span>
                  <strong>{result.stopReason}</strong>
                </div>
                <div>
                  <span>轮次</span>
                  <strong>{result.rounds.length}</strong>
                </div>
                <div>
                  <span>耗时</span>
                  <strong>{result.durationMs} ms</strong>
                </div>
                <div>
                  <span>Token</span>
                  <strong>
                    {result.usage.inputTokens} 输入 / {result.usage.outputTokens} 输出
                  </strong>
                </div>
                <div>
                  <span>AI Points</span>
                  <strong>
                    {result.usage.aiPoints} 已用 / {result.usage.costBudgetPoints} 预算 /{' '}
                    {result.usage.remainingAiPoints} 剩余
                  </strong>
                </div>
                <ol className="kb2-search-deep-rounds">
                  {result.rounds.map((round) => (
                    <li key={round.round}>
                      <strong>第 {round.round} 轮</strong>
                      <span>
                        {round.queries.join(' · ')} · 候选 {round.candidateCount} ·{' '}
                        {round.sufficient ? '证据充分' : '继续检索'} · Token{' '}
                        {round.inputTokens + round.outputTokens} · AI Points {round.aiPoints}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
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
              <option value="deep">Deep RAG 深度检索</option>
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
          {settingsDraft.mode === 'deep' ? (
            <>
              <ProductField label="最大轮次">
                <ProductInput
                  type="number"
                  min={1}
                  max={3}
                  aria-label="最大轮次"
                  value={settingsDraft.deepMaxRounds}
                  onChange={(event) =>
                    setSettingsDraft((current) => ({
                      ...current,
                      deepMaxRounds: Number(event.target.value),
                    }))
                  }
                />
              </ProductField>
              <ProductField label="单轮 token 预算">
                <ProductInput
                  type="number"
                  min={500}
                  max={20000}
                  aria-label="单轮 token 预算"
                  value={settingsDraft.deepRoundTokenBudget}
                  onChange={(event) =>
                    setSettingsDraft((current) => ({
                      ...current,
                      deepRoundTokenBudget: Number(event.target.value),
                    }))
                  }
                />
              </ProductField>
              <ProductField label="总 token 预算">
                <ProductInput
                  type="number"
                  min={500}
                  max={20000}
                  aria-label="总 token 预算"
                  value={settingsDraft.deepTokenBudget}
                  onChange={(event) =>
                    setSettingsDraft((current) => ({
                      ...current,
                      deepTokenBudget: Number(event.target.value),
                    }))
                  }
                />
              </ProductField>
              <ProductField label="AI Points 费用预算">
                <ProductInput
                  type="number"
                  min={0.000001}
                  max={1000000}
                  step={0.000001}
                  aria-label="AI Points 费用预算"
                  placeholder="留空使用工作区剩余额度"
                  value={settingsDraft.deepCostBudgetPoints ?? ''}
                  onChange={(event) =>
                    setSettingsDraft((current) => ({
                      ...current,
                      deepCostBudgetPoints:
                        event.target.value === '' ? undefined : Number(event.target.value),
                    }))
                  }
                />
              </ProductField>
              <div className="kb2-form-grid__full">
                <label className="kb2-checkbox-row">
                  <input
                    type="checkbox"
                    checked={settingsDraft.stopWhenNoNewEvidence}
                    onChange={(event) =>
                      setSettingsDraft((current) => ({
                        ...current,
                        stopWhenNoNewEvidence: event.target.checked,
                      }))
                    }
                  />
                  <span>无新证据时停止</span>
                </label>
              </div>
            </>
          ) : null}
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
          <ProductField label="ReRank 模型">
            <ProductSelect
              value={settingsDraft.rerankModelId}
              disabled={!settingsDraft.usingRerank || rerankModels.length === 0}
              onChange={(event) =>
                setSettingsDraft((current) => ({
                  ...current,
                  rerankModelId: event.target.value,
                }))
              }
            >
              <option value="">
                {rerankModels.length === 0 ? '没有可用的 ReRank 模型' : '使用知识库默认模型'}
              </option>
              {rerankModels.map((model) => (
                <option key={model.modelId} value={model.modelId}>
                  {model.displayName}
                </option>
              ))}
            </ProductSelect>
          </ProductField>
          <div className="kb2-form-grid__full">
            <label className="kb2-checkbox-row">
              <input
                type="checkbox"
                checked={settingsDraft.queryOptimizationEnabled}
                onChange={(event) =>
                  setSettingsDraft((current) => ({
                    ...current,
                    queryOptimizationEnabled: event.target.checked,
                  }))
                }
              />
              <span>启用问题优化</span>
            </label>
          </div>
          <ProductField label="问题优化模型">
            <ProductSelect
              value={settingsDraft.queryOptimizationModelId}
              disabled={!settingsDraft.queryOptimizationEnabled || llmModels.length === 0}
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
              disabled={!settingsDraft.queryOptimizationEnabled}
              rows={4}
              placeholder="补充业务背景、术语和查询改写约束"
              onChange={(event) =>
                setSettingsDraft((current) => ({
                  ...current,
                  queryOptimizationPrompt: event.target.value,
                }))
              }
            />
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
        </div>
        {settingsDraft.tagId ? (
          <TagFilterEditor
            tag={tags.find((tag) => tag.id === settingsDraft.tagId)}
            value={settingsDraft.tagValue}
            onChange={(tagValue) => setSettingsDraft((current) => ({ ...current, tagValue }))}
          />
        ) : null}
        {settingsError ? (
          <div className="kb2-search-warning" role="alert">
            <WarningIcon boxSize={4} />
            {settingsError}
          </div>
        ) : null}
        <div className="kb2-note">
          {settingsDraft.mode === 'deep'
            ? 'Deep RAG 仅使用文本 query，在轮次、token 和 AI Points 上限内逐步收集证据并签发引用。'
            : '问题优化会先调用所选文本模型改写查询；失败时保留原查询并显示降级状态。'}
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

function withoutEphemeralImagePreviews(result: SearchWorkspaceResult): SearchWorkspaceResult {
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
  if (mode === 'deep') return 'Deep RAG 深度检索';
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
