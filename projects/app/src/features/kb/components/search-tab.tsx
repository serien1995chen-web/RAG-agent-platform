import { useMemo, useState } from 'react';
import { kbApi, modelMode } from '../lib/kb-api';
import { useKbResource } from '../lib/use-kb-resource';
import type { SearchResultData } from '../types';
import styles from '../styles/kb.module.css';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  InlineError,
  Input,
  Notice,
  Select,
  Spinner,
} from './ui';

export function SearchTab({
  datasetId,
  onOpenCitation,
}: {
  datasetId: string;
  onOpenCitation: (collectionId: string, dataId: string) => void;
}) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'embedding' | 'fullTextRecall' | 'mixedRecall'>('embedding');
  const [limit, setLimit] = useState(10);
  const [similarity, setSimilarity] = useState(0);
  const [rerank, setRerank] = useState(false);
  const [embeddingWeight, setEmbeddingWeight] = useState(0.5);
  const [rerankWeight, setRerankWeight] = useState(0.5);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [result, setResult] = useState<SearchResultData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const tags = useKbResource(datasetId, () => kbApi.listTags(datasetId));
  const isMock = modelMode() === 'mock';
  const showWeights = mode === 'mixedRecall' || rerank;

  const filterExpression = useMemo(() => {
    if (selectedTags.length === 0) return undefined;
    return JSON.stringify({ tags: { $and: selectedTags } });
  }, [selectedTags]);

  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const next = await kbApi.searchTest({
        datasetId,
        text: text.trim(),
        searchMode: mode,
        limit,
        similarity,
        ...(rerank ? { usingReRank: true } : {}),
        ...(showWeights ? { embeddingWeight, rerankWeight } : {}),
        ...(filterExpression ? { collectionFilterMatch: filterExpression } : {}),
      });
      setResult(next);
    } catch (caught) {
      setError(caught);
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  const citations = result?.searchRes.citations ?? [];
  const stats = result?.searchRes.stats;

  return (
    <div className={styles.section}>
      {isMock ? (
        <Notice tone="info">
          Mock 模型：当前仅验证检索链路，结果不代表真实语义质量。模型能力由后续 Model &amp; AI
          模块接入。
        </Notice>
      ) : null}
      <div className={styles.searchLayout}>
        <div className={styles.panel}>
          <div className={styles.section}>
            {error ? <InlineError error={error} /> : null}
            <Field label="查询文本" required>
              <Input
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void submit();
                }}
                placeholder="输入要检索的问题"
              />
            </Field>
            <div className={styles.formGrid}>
              <Field label="检索模式">
                <Select
                  value={mode}
                  onChange={(event) => setMode(event.target.value as typeof mode)}
                >
                  <option value="embedding">向量检索</option>
                  <option value="fullTextRecall">全文检索</option>
                  <option value="mixedRecall">混合检索</option>
                </Select>
              </Field>
              <Field label="TopK" hint="1–50">
                <Input
                  type="number"
                  min={1}
                  max={50}
                  value={limit}
                  onChange={(event) =>
                    setLimit(Math.max(1, Math.min(50, Number(event.target.value) || 10)))
                  }
                />
              </Field>
              <Field label="相似度阈值" hint="0–1，越大越严格">
                <Input
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
              <Field label="Rerank">
                <label className={styles.checkRow}>
                  <input
                    type="checkbox"
                    checked={rerank}
                    onChange={(event) => setRerank(event.target.checked)}
                  />
                  使用 Rerank
                </label>
              </Field>
            </div>
            {showWeights ? (
              <div className={styles.formGrid}>
                <Field label="向量权重" hint="0–1">
                  <Input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={embeddingWeight}
                    onChange={(event) =>
                      setEmbeddingWeight(Math.max(0, Math.min(1, Number(event.target.value) || 0)))
                    }
                  />
                </Field>
                <Field label="Rerank 权重" hint="0–1">
                  <Input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={rerankWeight}
                    onChange={(event) =>
                      setRerankWeight(Math.max(0, Math.min(1, Number(event.target.value) || 0)))
                    }
                  />
                </Field>
              </div>
            ) : null}
            <Field label="标签过滤" hint="按标签缩小检索范围；不选标签时不加过滤。">
              <div className={styles.chips}>
                {(tags.data?.list ?? []).length > 0 ? (
                  tags.data?.list.map((tag) => (
                    <button
                      key={tag.tagId}
                      type="button"
                      className={`${styles.tagChipButton} ${
                        selectedTags.includes(tag.tagId) ? styles.tagChipButtonActive : ''
                      }`}
                      onClick={() =>
                        setSelectedTags((previous) =>
                          previous.includes(tag.tagId)
                            ? previous.filter((id) => id !== tag.tagId)
                            : [...previous, tag.tagId],
                        )
                      }
                    >
                      {tag.name}
                    </button>
                  ))
                ) : (
                  <span className={styles.muted}>暂无标签</span>
                )}
              </div>
            </Field>
            <Button
              variant="primary"
              onClick={() => void submit()}
              loading={busy}
              disabled={!text.trim()}
            >
              检索
            </Button>
          </div>
        </div>

        <div className={styles.panel}>
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle}>检索结果</h3>
            {stats?.durationMs !== undefined ? (
              <span className={styles.muted}>{stats.durationMs}ms</span>
            ) : null}
            {stats?.usingReRank ? <Badge tone="info">Rerank</Badge> : null}
            {stats?.usingSimilarityFilter ? <Badge tone="muted">相似度过滤</Badge> : null}
          </div>
          {busy ? <Spinner label="检索中" /> : null}
          {!busy && !result ? (
            <EmptyState
              title="输入问题开始检索"
              hint="训练完成的集合会出现在结果中；0 命中时会给出诊断信息。"
            />
          ) : null}
          {!busy && result && citations.length === 0 ? (
            <EmptyState
              title="未命中"
              hint={
                isMock
                  ? '当前为 Mock 模型，向量质量有限；也可能是集合训练未完成或过滤条件过严。'
                  : '可能是集合训练未完成、相似度阈值过严或过滤条件排除了全部集合。'
              }
            />
          ) : null}
          {citations.length > 0 ? (
            <div className={styles.citationList}>
              {citations.map((citation, index) => {
                const score =
                  citation.scores?.find((item) => item.type === 'rerank')?.value ??
                  citation.scores?.[0]?.value;
                return (
                  <div key={`${citation.dataId ?? index}`} className={styles.citationItem}>
                    <div className={styles.citationRank}>{index + 1}</div>
                    <div className={styles.citationBody}>
                      <div className={styles.citationQuote}>
                        {citation.quoteText || '（无文本内容）'}
                      </div>
                      <div className={styles.citationMeta}>
                        <span>{citation.sourceName ?? citation.collectionName ?? '未知来源'}</span>
                        {citation.dataId ? (
                          <button
                            type="button"
                            className={styles.linkButton}
                            onClick={() =>
                              citation.collectionId &&
                              citation.dataId &&
                              onOpenCitation(citation.collectionId, citation.dataId)
                            }
                          >
                            查看数据
                          </button>
                        ) : null}
                      </div>
                      {citation.scores && citation.scores.length > 0 ? (
                        <div className={styles.scoreRow}>
                          {typeof score === 'number' ? (
                            <span className={styles.score}>score {score.toFixed(4)}</span>
                          ) : null}
                          {citation.scores.map((item, scoreIndex) => (
                            <span key={`${item.type}-${scoreIndex}`} className={styles.score}>
                              {item.type} {item.value.toFixed(4)}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
          {result && stats ? (
            <div className={styles.section}>
              <details className={styles.diagnostics}>
                <summary>检索诊断</summary>
                <pre>{JSON.stringify(stats, null, 2)}</pre>
              </details>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
