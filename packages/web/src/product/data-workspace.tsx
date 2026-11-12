'use client';

import {
  AddIcon,
  CheckIcon,
  ChevronLeftIcon,
  DeleteIcon,
  DownloadIcon,
  EditIcon,
  RepeatIcon,
  WarningIcon,
} from '@chakra-ui/icons';
import { Spinner } from '@chakra-ui/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { S7MarkdownRenderer } from '../components/s7-markdown-renderer';
import {
  batchSegments,
  batchUpsertSegments,
  createSegment,
  createSegmentIndex,
  deleteSegment,
  deleteSegmentIndex,
  productApi,
  updateSegment,
  updateSegmentIndex,
} from './api';
import {
  segmentDisplayContent,
  segmentModeForSource,
  sourceKindLabel,
  sourceStatusView,
} from './dataset-detail-state';
import type { BatchResult, KnowledgeSpace, Segment, SegmentHistory } from './types';
import {
  ProductButton,
  ProductCheckbox,
  ProductEmpty,
  ProductError,
  ProductField,
  ProductIconButton,
  ProductInput,
  ProductModal,
  ProductPage,
  ProductPageHeader,
  ProductSearchBox,
  ProductSelect,
  ProductSkeleton,
  ProductTextarea,
  ProductTypeIcon,
  StatusTag,
  formatBytes,
  productTypeOf,
  useProductToast,
} from './ui';

type SegmentMode = 'chunk' | 'qa' | 'image';

const PAGE_SIZE = 20;

export function DataWorkspace(props: {
  space?: KnowledgeSpace;
  sourceId: string;
  onBack: () => void;
  onRetrain: () => void;
}) {
  const toast = useProductToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingSegment, setEditingSegment] = useState<Segment | null>(null);
  const [editorMode, setEditorMode] = useState<SegmentMode>('chunk');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [searchEnabled, setSearchEnabled] = useState(true);
  const [editorBusy, setEditorBusy] = useState(false);
  const [editorError, setEditorError] = useState<unknown>(null);
  const [newIndexText, setNewIndexText] = useState('');
  const [newIndexModelId, setNewIndexModelId] = useState('');
  const [createIndexes, setCreateIndexes] = useState<
    Array<{ indexId: string; text: string; modelId: string }>
  >([]);
  const [indexDrafts, setIndexDrafts] = useState<Record<string, string>>({});
  const [indexBusy, setIndexBusy] = useState(false);
  const [indexError, setIndexError] = useState<unknown>(null);
  const [deleteTarget, setDeleteTarget] = useState<Segment | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<unknown>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchError, setBatchError] = useState<unknown>(null);
  const [batchResult, setBatchResult] = useState<BatchResult | null>(null);
  const [batchUpsertOpen, setBatchUpsertOpen] = useState(false);
  const [batchUpsertText, setBatchUpsertText] = useState('');
  const [batchRetryTexts, setBatchRetryTexts] = useState<string[]>([]);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [batchDeleteText, setBatchDeleteText] = useState('');
  const [capabilityMessage, setCapabilityMessage] = useState('');
  const [failureDetailOpen, setFailureDetailOpen] = useState(false);

  const sourceQuery = useQuery({
    queryKey: ['kb-product', 'source', props.sourceId],
    queryFn: () => productApi.getSource(props.sourceId),
    enabled: Boolean(props.sourceId),
  });
  const segmentsQuery = useQuery({
    queryKey: ['kb-product', 'segments', props.sourceId],
    queryFn: () => productApi.listSegments(props.sourceId),
    enabled: Boolean(props.sourceId),
    refetchInterval: (data) =>
      data?.some((segment) =>
        ['pending', 'indexing', 'rebuilding', 'rebuild_failed'].includes(segment.indexStatus),
      )
        ? 10_000
        : false,
    refetchIntervalInBackground: false,
  });
  const modelsQuery = useQuery({
    queryKey: ['kb-product', 'models'],
    queryFn: () => productApi.listModels(),
    enabled: Boolean(props.space?.id),
  });
  const bindingsQuery = useQuery({
    queryKey: ['kb-product', 'model-bindings', props.space?.id],
    queryFn: () => productApi.getModelBindings(props.space!.id),
    enabled: Boolean(props.space?.id),
  });
  const tagsQuery = useQuery({
    queryKey: ['kb-product', 'tags', props.space?.id],
    queryFn: () => productApi.listTags(props.space!.id),
    enabled: Boolean(props.space?.id),
  });
  const historyQuery = useQuery({
    queryKey: ['kb-product', 'segment-history', editingSegment?.id],
    queryFn: () => productApi.getSegmentHistory(editingSegment!.id),
    enabled: Boolean(editingSegment?.id),
  });
  const failureJobsQuery = useQuery({
    queryKey: ['kb-product', 'jobs'],
    queryFn: () => productApi.listJobs(),
    enabled: failureDetailOpen && Boolean(editingSegment?.id),
  });

  const source = sourceQuery.data;
  const segments = segmentsQuery.data ?? [];
  const models = modelsQuery.data ?? [];
  const bindings = bindingsQuery.data?.items ?? [];
  const tags = tagsQuery.data ?? [];
  const tagById = useMemo(() => new Map(tags.map((tag) => [tag.id, tag])), [tags]);
  const embeddingModelId =
    bindings.find((binding) => binding.modelType === 'embedding' && binding.status === 'active')
      ?.modelId ??
    models.find((model) => model.type === 'embedding' && model.authorized)?.modelId ??
    '';
  const filteredSegments = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase('zh-CN');
    if (!keyword) return segments;
    return segments.filter((segment) => {
      const display = segmentDisplayContent(segment);
      return `${display.question} ${display.answer} ${segment.content}`
        .toLocaleLowerCase('zh-CN')
        .includes(keyword);
    });
  }, [search, segments]);
  const visibleSegments = filteredSegments.slice(0, visibleCount);
  const selectedSegments = segments.filter((segment) => selectedIds.includes(segment.id));
  const indexedCount = segments.filter((segment) => segment.indexStatus === 'indexed').length;
  const status = sourceStatusView(source?.processingStatus ?? '');
  const history = historyQuery.data?.items ?? [];
  const failureJob = failureJobsQuery.data?.find(
    (job) => job.resourceType === 'segment' && job.resourceId === editingSegment?.id,
  );
  const canSubmitEditor =
    Boolean(question.trim()) && (editorMode !== 'qa' || Boolean(answer.trim())) && !editorBusy;

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['kb-product', 'source', props.sourceId] }),
      queryClient.invalidateQueries({ queryKey: ['kb-product', 'segments', props.sourceId] }),
      queryClient.invalidateQueries({
        queryKey: ['kb-product', 'sources', source?.knowledgeSpaceId],
      }),
      queryClient.invalidateQueries({ queryKey: ['kb-product', 'jobs'] }),
      queryClient.invalidateQueries({
        queryKey: ['kb-product', 'segment-history', editingSegment?.id],
      }),
    ]);
  };

  const openCreate = () => {
    if (source?.kind === 'image') {
      setCapabilityMessage(
        '当前 Segment 合同没有新增图片的分块接口。请在 Import 的“图片集合”来源中上传图片。',
      );
      return;
    }
    setEditingSegment(null);
    setEditorMode(segmentModeForSource(source));
    setQuestion('');
    setAnswer('');
    setSearchEnabled(true);
    setNewIndexText('');
    setNewIndexModelId(embeddingModelId);
    setCreateIndexes([]);
    setIndexDrafts({});
    setEditorError(null);
    setIndexError(null);
    setFailureDetailOpen(false);
    setEditorOpen(true);
  };

  const openEdit = (segment: Segment) => {
    if (['pending', 'indexing', 'rebuilding'].includes(segment.indexStatus)) {
      toast.warning('数据索引中，暂不可更改');
      return;
    }
    const display = segmentDisplayContent(segment);
    setEditingSegment(segment);
    setEditorMode(source?.kind === 'image' ? 'image' : display.answer ? 'qa' : 'chunk');
    setQuestion(display.question);
    setAnswer(display.answer);
    setSearchEnabled(segment.searchEnabled);
    setIndexDrafts(Object.fromEntries(segment.indexes.map((index) => [index.indexId, index.text])));
    setEditorError(null);
    setIndexError(null);
    setFailureDetailOpen(false);
    setEditorOpen(true);
  };

  const saveSegment = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmitEditor) return;
    setEditorBusy(true);
    setEditorError(null);
    try {
      if (editingSegment) {
        await updateSegment(editingSegment, {
          question: question,
          answer: editorMode === 'qa' ? answer : '',
          searchEnabled,
        });
      } else {
        await createSegment(props.sourceId, {
          question,
          answer: editorMode === 'qa' ? answer : question,
          segmentType: editorMode === 'qa' ? 'qa' : 'chunk',
          searchEnabled,
          indexes: createIndexes.map((index) => ({
            indexId: index.indexId,
            type: 'custom' as const,
            text: index.text,
            modelId: index.modelId,
          })),
        });
      }
      await invalidate();
      setEditorOpen(false);
      setCreateIndexes([]);
      toast.success(editingSegment ? '数据已更新' : '数据已插入');
    } catch (caught) {
      setEditorError(caught);
    } finally {
      setEditorBusy(false);
    }
  };

  const removeSegment = async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await deleteSegment(deleteTarget);
      await invalidate();
      setDeleteTarget(null);
      toast.success('删除成功');
    } catch (caught) {
      setDeleteError(caught);
    } finally {
      setDeleteBusy(false);
    }
  };

  const runBatch = async (action: 'delete' | 'reindex') => {
    if (selectedSegments.length === 0) return;
    setBatchBusy(true);
    setBatchError(null);
    try {
      const result = await batchSegments(action, selectedSegments);
      setBatchResult(result);
      const failedIds = result.items.filter((item) => !item.success).map((item) => item.id);
      setSelectedIds(failedIds);
      await invalidate();
      if (result.failed === 0) {
        setBatchMode(false);
        toast.success(action === 'delete' ? '删除成功' : '已提交重建索引');
      } else {
        toast.warning('批量操作部分失败');
      }
    } catch (caught) {
      setBatchError(caught);
    } finally {
      setBatchBusy(false);
    }
  };

  const runBatchUpsert = async (retryTexts?: string[]) => {
    const texts = (retryTexts ?? batchUpsertText.split(/\r?\n/))
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (texts.length === 0 || texts.length > 200) return;
    setBatchBusy(true);
    setBatchError(null);
    setBatchResult(null);
    try {
      const result = await batchUpsertSegments(
        props.sourceId,
        texts.map((text) => ({
          question: text,
          answer: text,
          segmentType: 'chunk' as const,
          searchEnabled: true,
        })),
      );
      setBatchResult(result);
      const failedIndexes = result.items
        .filter((item) => !item.success)
        .map((item) => item.index)
        .filter((index): index is number => index !== undefined);
      setBatchRetryTexts(
        failedIndexes
          .map((index) => texts[index])
          .filter((value): value is string => Boolean(value)),
      );
      await invalidate();
      if (result.failed === 0) {
        toast.success(`已提交 ${result.succeeded} 项`);
        setBatchUpsertText('');
      } else {
        toast.warning('批量插入部分失败');
      }
    } catch (caught) {
      setBatchError(caught);
    } finally {
      setBatchBusy(false);
    }
  };

  const addIndex = async () => {
    if (!editingSegment || !newIndexText.trim() || !newIndexModelId) return;
    setIndexBusy(true);
    setIndexError(null);
    try {
      const updated = await createSegmentIndex(editingSegment, {
        indexId: `custom_${Date.now().toString(36)}`,
        text: newIndexText.trim(),
        modelId: newIndexModelId,
      });
      setEditingSegment(updated);
      setIndexDrafts(
        Object.fromEntries(updated.indexes.map((index) => [index.indexId, index.text])),
      );
      setNewIndexText('');
      await invalidate();
      toast.success('索引已添加');
    } catch (caught) {
      setIndexError(caught);
    } finally {
      setIndexBusy(false);
    }
  };

  const addCreateIndex = () => {
    const text = newIndexText.trim();
    if (!text || !newIndexModelId) return;
    setCreateIndexes((current) => [
      ...current,
      {
        indexId: `custom_${Date.now().toString(36)}`,
        text,
        modelId: newIndexModelId,
      },
    ]);
    setNewIndexText('');
  };

  const saveIndex = async (index: Segment['indexes'][number]) => {
    if (!editingSegment) return;
    setIndexBusy(true);
    setIndexError(null);
    try {
      const updated = await updateSegmentIndex(
        editingSegment,
        index,
        indexDrafts[index.indexId] ?? index.text,
      );
      setEditingSegment(updated);
      setIndexDrafts(Object.fromEntries(updated.indexes.map((item) => [item.indexId, item.text])));
      await invalidate();
      toast.success('索引已保存');
    } catch (caught) {
      setIndexError(caught);
    } finally {
      setIndexBusy(false);
    }
  };

  const removeIndex = async (indexId: string) => {
    if (!editingSegment) return;
    setIndexBusy(true);
    setIndexError(null);
    try {
      await deleteSegmentIndex(editingSegment, indexId);
      await invalidate();
      await segmentsQuery.refetch();
      setEditorOpen(false);
      toast.success('索引已删除');
    } catch (caught) {
      setIndexError(caught);
    } finally {
      setIndexBusy(false);
    }
  };

  return (
    <ProductPage className="kb2-data-page">
      <ProductPageHeader
        breadcrumbs={
          <button type="button" onClick={props.onBack}>
            {props.space?.name ?? '知识库'}
          </button>
        }
        title={
          <div className="kb2-data-title">
            <ProductTypeIcon kind={productTypeOf(source?.kind).kind} />
            <span>{source?.name ?? '数据'}</span>
            <StatusTag value={status.label} tone={status.tone} dot />
          </div>
        }
        description={`${source ? sourceKindLabel(source.kind) : ''} · ${source?.id ?? props.sourceId}`}
        actions={
          <>
            <ProductButton onClick={props.onBack}>
              <ChevronLeftIcon boxSize={3.5} />
              返回
            </ProductButton>
            <ProductButton
              onClick={() => {
                setCapabilityMessage(
                  '当前后端没有分块 CSV 导出接口。此按钮保留设计，但不会用原文件下载冒充分块导出。',
                );
              }}
            >
              <DownloadIcon boxSize={3.5} />
              导出分块
            </ProductButton>
            <ProductButton onClick={props.onRetrain}>
              <RepeatIcon boxSize={3.5} />
              调整训练参数
            </ProductButton>
            <ProductButton tone="primary" onClick={openCreate}>
              <AddIcon boxSize={3.5} />
              插入
            </ProductButton>
          </>
        }
      />

      <ProductError
        error={sourceQuery.error ?? segmentsQuery.error ?? batchError}
        onRetry={() => {
          void sourceQuery.refetch();
          void segmentsQuery.refetch();
        }}
      />
      {capabilityMessage ? (
        <div className="kb2-error-panel" role="alert">
          <WarningIcon boxSize={4} />
          <div>
            <strong>后端能力未实现</strong>
            <span>{capabilityMessage}</span>
          </div>
          <ProductButton size="sm" onClick={() => setCapabilityMessage('')}>
            关闭
          </ProductButton>
        </div>
      ) : null}

      <div className="kb2-data-layout">
        <section className="kb2-data-panel" aria-label="Data 列表">
          <div className="kb2-data-head">
            <div>
              <strong>{segments.length}</strong>
              <span>条数据</span>
              <strong>{indexedCount}</strong>
              <span>条已索引</span>
            </div>
            <div className="kb2-toolbar__controls">
              <ProductSearchBox
                value={search}
                onChange={(value) => {
                  setSearch(value);
                  setVisibleCount(PAGE_SIZE);
                }}
                placeholder="搜索数据块"
              />
              <ProductButton
                tone={batchMode ? 'primary' : 'secondary'}
                onClick={() => {
                  setBatchMode((value) => !value);
                  setSelectedIds([]);
                }}
              >
                <CheckIcon boxSize={3.5} />
                批量管理
              </ProductButton>
            </div>
          </div>

          {segmentsQuery.isLoading ? (
            <div className="kb2-data-skeleton">
              <ProductSkeleton rows={3} />
            </div>
          ) : filteredSegments.length === 0 ? (
            <ProductEmpty
              title={search ? '没有匹配的数据块' : '这个集合还没有数据'}
              description={
                search ? '清空搜索条件后查看全部数据。' : '通过“插入”或 Import 添加数据。'
              }
            />
          ) : (
            <div className="kb2-data-list">
              {visibleSegments.map((segment, index) => {
                const display = segmentDisplayContent(segment);
                const status = segmentStatusView(segment.indexStatus);
                const selected = selectedIds.includes(segment.id);
                return (
                  <article
                    key={segment.id}
                    className={`kb2-data-card kb2-data-card--${index % 2 === 0 ? 'a' : 'b'}${selected ? ' is-selected' : ''}`}
                    onClick={() => {
                      if (batchMode) {
                        setSelectedIds((current) =>
                          selected
                            ? current.filter((id) => id !== segment.id)
                            : [...current, segment.id],
                        );
                        return;
                      }
                      openEdit(segment);
                    }}
                  >
                    <div className="kb2-data-card__meta">
                      {batchMode ? (
                        <span onClick={(event) => event.stopPropagation()}>
                          <ProductCheckbox
                            checked={selected}
                            onChange={(checked) =>
                              setSelectedIds((current) =>
                                checked
                                  ? [...new Set([...current, segment.id])]
                                  : current.filter((id) => id !== segment.id),
                              )
                            }
                            label={`选择数据块 ${segment.order + 1}`}
                          />
                        </span>
                      ) : (
                        <span className="kb2-data-order">#{segment.order + 1}</span>
                      )}
                      <span className="kb2-inline-code">{segment.id}</span>
                      <StatusTag value={status.label} tone={status.tone} dot />
                    </div>
                    {segment.imageBlobRefId ? (
                      <SegmentImage
                        blobId={segment.imageBlobRefId}
                        alt={`数据块 ${segment.order + 1}`}
                      />
                    ) : null}
                    <S7MarkdownRenderer className="kb2-data-content">
                      {display.question}
                    </S7MarkdownRenderer>
                    {display.answer ? (
                      <div className="kb2-data-answer">
                        <span>答案</span>
                        <S7MarkdownRenderer>{display.answer}</S7MarkdownRenderer>
                      </div>
                    ) : null}
                    <div className="kb2-data-card__footer">
                      <span>
                        {segment.content.replace(/\s+/g, ' ').length} 字符 · 版本 {segment.version}
                      </span>
                      {!batchMode ? (
                        <span
                          className="kb2-row-actions"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <ProductIconButton
                            label={`编辑数据块 ${segment.order + 1}`}
                            onClick={() => openEdit(segment)}
                          >
                            <EditIcon boxSize={3.5} />
                          </ProductIconButton>
                          <ProductIconButton
                            label={`删除数据块 ${segment.order + 1}`}
                            tone="danger"
                            onClick={() => setDeleteTarget(segment)}
                          >
                            <DeleteIcon boxSize={3.5} />
                          </ProductIconButton>
                        </span>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
          {visibleCount < filteredSegments.length ? (
            <div className="kb2-load-more">
              <ProductButton onClick={() => setVisibleCount((value) => value + PAGE_SIZE)}>
                加载更多（剩余 {filteredSegments.length - visibleCount}）
              </ProductButton>
            </div>
          ) : null}
        </section>

        <aside className="kb2-meta-panel" aria-label="数据元信息">
          <h2>元数据</h2>
          <InfoRow label="Source ID" value={source?.id ?? props.sourceId} />
          <InfoRow label="来源类型" value={source ? sourceKindLabel(source.kind) : '—'} />
          <InfoRow label="名称" value={source?.name ?? '—'} />
          <InfoRow label="文件大小" value={formatBytes(source?.sizeBytes)} />
          <InfoRow label="Source 版本" value={String(source?.sourceVersion ?? '—')} />
          <InfoRow label="更新时间" value="后端未提供" />
          <InfoRow label="权限模式" value={source?.permissionState ?? '—'} />
          <InfoRow label="权限版本" value={String(source?.permissionRevision ?? '—')} />
          <div className="kb2-info-group">
            <h3>标签</h3>
            {source?.tagValues?.length ? (
              source.tagValues.map((tag) => (
                <InfoRow
                  key={`${tag.tagId}-${tag.valueKey}`}
                  label={tagById.get(tag.tagId)?.label ?? tag.tagId}
                  value={formatTagValue(tag.value)}
                />
              ))
            ) : (
              <span className="kb2-table-muted">未设置标签</span>
            )}
          </div>
          <div className="kb2-info-group">
            <h3>Source 权限</h3>
            <ProductButton size="sm" className="kb2-full-button" onClick={props.onBack}>
              返回 Collection 管理权限
            </ProductButton>
          </div>
        </aside>
      </div>

      {batchMode && selectedIds.length > 0 ? (
        <div className="kb2-batch-bar" role="region" aria-label="Data 批量操作">
          <span className="kb2-batch-bar__count">已选择 {selectedIds.length} 条数据</span>
          <ProductButton
            busy={batchBusy}
            onClick={() => {
              setBatchError(null);
              setBatchResult(null);
              setBatchRetryTexts([]);
              setBatchUpsertOpen(true);
            }}
          >
            批量插入
          </ProductButton>
          <ProductButton busy={batchBusy} onClick={() => void runBatch('reindex')}>
            重建索引
          </ProductButton>
          <ProductButton
            tone="danger"
            busy={batchBusy}
            onClick={() => {
              setBatchDeleteText('');
              setBatchDeleteOpen(true);
            }}
          >
            批量删除
          </ProductButton>
          <ProductButton tone="secondary" onClick={() => setSelectedIds([])}>
            清空选择
          </ProductButton>
        </div>
      ) : null}
      {batchResult ? (
        <div className="kb2-note" role="status">
          批量操作结果：成功 {batchResult.succeeded} 项，失败 {batchResult.failed} 项。
        </div>
      ) : null}

      <ProductModal
        open={editorOpen}
        title={editingSegment ? `编辑数据 #${editingSegment.order + 1}` : '插入数据'}
        description={source?.name}
        size="xl"
        onClose={() => !editorBusy && setEditorOpen(false)}
        footer={
          <>
            <ProductButton onClick={() => setEditorOpen(false)} disabled={editorBusy}>
              取消
            </ProductButton>
            <ProductButton
              tone="primary"
              busy={editorBusy}
              disabled={!canSubmitEditor}
              onClick={() =>
                (
                  document.getElementById('kb2-segment-form') as HTMLFormElement | null
                )?.requestSubmit()
              }
            >
              {editingSegment ? '保存' : '插入'}
            </ProductButton>
          </>
        }
      >
        <div className="kb2-data-editor">
          <form id="kb2-segment-form" className="kb2-data-editor__main" onSubmit={saveSegment}>
            {source?.kind !== 'image' ? (
              <div className="kb2-segment-tabs" role="tablist" aria-label="数据模式">
                <button
                  type="button"
                  role="tab"
                  aria-selected={editorMode === 'chunk'}
                  onClick={() => setEditorMode('chunk')}
                >
                  分块
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={editorMode === 'qa'}
                  onClick={() => setEditorMode('qa')}
                >
                  问答对
                </button>
              </div>
            ) : null}
            {editingSegment?.imageBlobRefId ? (
              <SegmentImage blobId={editingSegment.imageBlobRefId} alt="数据图片" />
            ) : null}
            <ProductField label={editorMode === 'qa' ? '问题' : '分块内容'}>
              <ProductTextarea
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                rows={8}
                autoFocus
              />
            </ProductField>
            {editorMode === 'qa' ? (
              <ProductField label="答案">
                <ProductTextarea
                  value={answer}
                  onChange={(event) => setAnswer(event.target.value)}
                  rows={7}
                />
              </ProductField>
            ) : null}
            <label className="kb2-checkbox-row">
              <input
                type="checkbox"
                checked={searchEnabled}
                onChange={(event) => setSearchEnabled(event.target.checked)}
              />
              <span>参与检索</span>
            </label>
            <ProductError error={editorError} />
            {editingSegment ? (
              <section className="kb2-history-panel" aria-labelledby="kb2-segment-history-title">
                <div className="kb2-history-panel__head">
                  <h3 id="kb2-segment-history-title">编辑历史</h3>
                  <span>{history.length} 条</span>
                </div>
                <ProductError
                  error={historyQuery.error}
                  onRetry={() => void historyQuery.refetch()}
                />
                {historyQuery.isLoading ? (
                  <ProductSkeleton rows={2} />
                ) : history.length === 0 ? (
                  <p className="kb2-table-muted">暂无可追溯的历史记录。</p>
                ) : (
                  <div className="kb2-history-list">
                    {history.map((entry) => (
                      <HistoryItem
                        key={`${entry.version}-${entry.changedAt}-${entry.operation ?? 'history'}`}
                        entry={entry}
                      />
                    ))}
                  </div>
                )}
              </section>
            ) : null}
          </form>
          <aside className="kb2-index-panel">
            <div className="kb2-index-panel__head">
              <h3>索引 {editingSegment?.indexes.length ?? createIndexes.length}</h3>
              <span>系统索引只读</span>
            </div>
            {editingSegment && ['error', 'rebuild_failed'].includes(editingSegment.indexStatus) ? (
              <section className="kb2-failure-panel" aria-labelledby="kb2-failure-title">
                <h3 id="kb2-failure-title">索引失败</h3>
                <code>{editingSegment.indexErrorCode ?? 'KNOWLEDGE_UNKNOWN_INDEX_FAILURE'}</code>
                <ProductButton size="sm" onClick={() => setFailureDetailOpen(true)}>
                  训练详情
                </ProductButton>
              </section>
            ) : null}
            {editingSegment?.indexes.map((index) => (
              <div className="kb2-index-row" key={index.indexId}>
                <div>
                  <strong>{index.type}</strong>
                  <small>{index.modelId}</small>
                </div>
                {index.type === 'custom' ? (
                  <ProductTextarea
                    value={indexDrafts[index.indexId] ?? index.text}
                    onChange={(event) =>
                      setIndexDrafts((current) => ({
                        ...current,
                        [index.indexId]: event.target.value,
                      }))
                    }
                    rows={3}
                  />
                ) : (
                  <p>{index.text}</p>
                )}
                {index.type === 'custom' ? (
                  <div className="kb2-inline-actions">
                    <ProductButton size="sm" busy={indexBusy} onClick={() => void saveIndex(index)}>
                      重新保存
                    </ProductButton>
                    <ProductIconButton
                      label="删除索引"
                      tone="danger"
                      onClick={() => void removeIndex(index.indexId)}
                    >
                      <DeleteIcon boxSize={3.5} />
                    </ProductIconButton>
                  </div>
                ) : null}
              </div>
            ))}
            {!editingSegment
              ? createIndexes.map((index) => (
                  <div className="kb2-index-row" key={index.indexId}>
                    <div>
                      <strong>custom</strong>
                      <small>{index.modelId}</small>
                    </div>
                    <p>{index.text}</p>
                    <div className="kb2-inline-actions">
                      <ProductIconButton
                        label="删除索引草稿"
                        tone="danger"
                        onClick={() =>
                          setCreateIndexes((current) =>
                            current.filter((entry) => entry.indexId !== index.indexId),
                          )
                        }
                      >
                        <DeleteIcon boxSize={3.5} />
                      </ProductIconButton>
                    </div>
                  </div>
                ))
              : null}
            <div className="kb2-index-create">
              <ProductField label="自定义索引">
                <ProductTextarea
                  value={newIndexText}
                  onChange={(event) => setNewIndexText(event.target.value)}
                  rows={3}
                />
              </ProductField>
              <ProductField label="向量模型">
                <ProductSelect
                  value={newIndexModelId}
                  onChange={(event) => setNewIndexModelId(event.target.value)}
                >
                  <option value="">选择模型</option>
                  {models
                    .filter((model) => model.type === 'embedding' && model.authorized)
                    .map((model) => (
                      <option key={model.modelId} value={model.modelId}>
                        {model.displayName}
                      </option>
                    ))}
                </ProductSelect>
              </ProductField>
              <ProductButton
                size="sm"
                busy={indexBusy}
                disabled={!newIndexText.trim() || !newIndexModelId}
                onClick={() => (editingSegment ? void addIndex() : addCreateIndex())}
              >
                {editingSegment ? '添加索引' : '新增索引'}
              </ProductButton>
              <ProductError error={indexError} />
            </div>
          </aside>
        </div>
      </ProductModal>

      <ProductModal
        open={failureDetailOpen}
        title="训练详情"
        description={editingSegment ? `数据 #${editingSegment.order + 1}` : undefined}
        onClose={() => setFailureDetailOpen(false)}
      >
        <ProductError
          error={failureJobsQuery.error}
          onRetry={() => void failureJobsQuery.refetch()}
        />
        {failureJobsQuery.isLoading ? (
          <ProductSkeleton rows={3} />
        ) : failureJob ? (
          <div className="kb2-job-detail">
            <div>
              <span>Job</span>
              <code>{failureJob.jobId}</code>
            </div>
            <div>
              <span>状态</span>
              <strong>{failureJob.status}</strong>
            </div>
            <div>
              <span>错误码</span>
              <code>{failureJob.error?.code ?? editingSegment?.indexErrorCode ?? '—'}</code>
            </div>
            <div>
              <span>更新时间</span>
              <strong>{new Date(failureJob.updatedAt).toLocaleString('zh-CN')}</strong>
            </div>
            <h3>执行步骤</h3>
            {failureJob.steps?.length ? (
              <ul>
                {failureJob.steps.map((step, index) => {
                  const error = step.error as { code?: unknown } | null | undefined;
                  return (
                    <li key={`${String(step.stepKey ?? index)}-${index}`}>
                      <strong>{String(step.stepKey ?? `步骤 ${index + 1}`)}</strong>
                      <span>{String(step.status ?? 'unknown')}</span>
                      {error?.code ? <code>{String(error.code)}</code> : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="kb2-table-muted">该 Job 没有可展示的步骤记录。</p>
            )}
          </div>
        ) : (
          <p className="kb2-table-muted">暂无可展示的 Job 详情。</p>
        )}
      </ProductModal>

      <ProductModal
        open={Boolean(deleteTarget)}
        title="删除数据"
        description="删除后无法自动恢复。"
        onClose={() => !deleteBusy && setDeleteTarget(null)}
        footer={
          <>
            <ProductButton onClick={() => setDeleteTarget(null)} disabled={deleteBusy}>
              取消
            </ProductButton>
            <ProductButton tone="danger" busy={deleteBusy} onClick={() => void removeSegment()}>
              确认删除
            </ProductButton>
          </>
        }
      >
        <p className="kb2-confirm-copy">
          确认删除数据块 <strong>#{deleteTarget?.order ? deleteTarget.order + 1 : ''}</strong>？
        </p>
        <ProductError error={deleteError} />
      </ProductModal>

      <ProductModal
        open={batchUpsertOpen}
        title="批量插入数据"
        description={`目标：${source?.name ?? props.sourceId}`}
        size="lg"
        onClose={() => !batchBusy && setBatchUpsertOpen(false)}
        footer={
          <>
            <ProductButton disabled={batchBusy} onClick={() => setBatchUpsertOpen(false)}>
              关闭
            </ProductButton>
            {batchRetryTexts.length > 0 ? (
              <ProductButton busy={batchBusy} onClick={() => void runBatchUpsert(batchRetryTexts)}>
                重试失败项（{batchRetryTexts.length}）
              </ProductButton>
            ) : null}
            <ProductButton
              tone="primary"
              busy={batchBusy}
              disabled={
                batchUpsertText
                  .split(/\r?\n/)
                  .map((entry) => entry.trim())
                  .filter(Boolean).length === 0
              }
              onClick={() => void runBatchUpsert()}
            >
              提交批量插入
            </ProductButton>
          </>
        }
      >
        <div className="kb2-batch-upsert">
          <ProductField label="批量分块内容（每行一条）">
            <ProductTextarea
              value={batchUpsertText}
              onChange={(event) => {
                setBatchUpsertText(event.target.value);
                setBatchResult(null);
                setBatchRetryTexts([]);
              }}
              rows={8}
            />
          </ProductField>
          {batchBusy ? (
            <div role="status" className="kb2-note">
              <Spinner size="sm" /> 正在向目标 Source 提交批量请求…
            </div>
          ) : null}
          <ProductError error={batchError} />
          {batchResult ? (
            <section aria-label="批量插入结果">
              <div className="kb2-info-group">
                <div className="kb2-info-line">
                  <span>处理结果</span>
                  <strong>
                    共 {batchResult.requested} 项，成功 {batchResult.succeeded}，失败{' '}
                    {batchResult.failed}
                  </strong>
                </div>
              </div>
              <div className="kb2-table" role="table" aria-label="批量插入逐项结果">
                {batchResult.items.map((item, index) => (
                  <div
                    className="kb2-catalog-row"
                    role="row"
                    key={`${item.id}-${item.index ?? index}`}
                  >
                    <span role="cell">第 {(item.index ?? index) + 1} 项</span>
                    <StatusTag
                      value={item.success ? '已提交索引' : (item.code ?? '失败')}
                      tone={item.success ? 'success' : 'danger'}
                      dot
                    />
                    {item.jobIds?.length || item.jobId ? (
                      <small role="cell">
                        Job {(item.jobIds ?? [item.jobId]).filter(Boolean).join(', ')}
                      </small>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </ProductModal>

      <ProductModal
        open={batchDeleteOpen}
        title="批量删除数据"
        description={`将删除 ${selectedSegments.length} 条数据`}
        onClose={() => !batchBusy && setBatchDeleteOpen(false)}
        footer={
          <>
            <ProductButton onClick={() => setBatchDeleteOpen(false)} disabled={batchBusy}>
              取消
            </ProductButton>
            <ProductButton
              tone="danger"
              busy={batchBusy}
              disabled={batchDeleteText !== '确认删除'}
              onClick={() => {
                setBatchDeleteOpen(false);
                void runBatch('delete');
              }}
            >
              确认删除
            </ProductButton>
          </>
        }
      >
        <p className="kb2-confirm-copy">
          请输入 <strong>确认删除</strong> 以确认。
        </p>
        <ProductField label="确认文本">
          <ProductInput
            value={batchDeleteText}
            onChange={(event) => setBatchDeleteText(event.target.value)}
          />
        </ProductField>
        <ProductError error={batchError} />
      </ProductModal>
    </ProductPage>
  );
}

function HistoryItem(props: { entry: SegmentHistory }) {
  const indexIds = [
    ...new Set([
      ...(props.entry.indexes ?? []).map((index) => index.indexId),
      ...(props.entry.nextIndexes ?? []).map((index) => index.indexId),
    ]),
  ];
  return (
    <article className="kb2-history-item">
      <div>
        <strong>v{props.entry.version}</strong>
        <span>{historyOperationLabel(props.entry.operation)}</span>
        <time dateTime={props.entry.changedAt}>
          {new Date(props.entry.changedAt).toLocaleString('zh-CN')}
        </time>
      </div>
      <p>{props.entry.question || '空问题'}</p>
      {props.entry.answer ? <p>{props.entry.answer}</p> : null}
      <small>操作者 {props.entry.changedByMemberId}</small>
      {indexIds.length > 0 ? (
        <small>
          索引变化：
          {indexIds
            .map((indexId) => (props.entry.indexId === indexId ? `[${indexId}]` : indexId))
            .join('、')}
        </small>
      ) : null}
    </article>
  );
}

function historyOperationLabel(operation?: SegmentHistory['operation']) {
  if (operation === 'segment.update') return '编辑内容';
  if (operation === 'index.create') return '新增索引';
  if (operation === 'index.update') return '更新索引';
  if (operation === 'index.delete') return '删除索引';
  if (operation === 'index.reindex') return '重建索引';
  return '编辑记录';
}

function SegmentImage(props: { blobId: string; alt: string }) {
  const ticket = useQuery({
    queryKey: ['kb-product', 'file-preview', props.blobId],
    queryFn: () => productApi.previewFile(props.blobId),
  });
  if (ticket.isLoading) {
    return (
      <div className="kb2-center-state">
        <Spinner size="sm" />
        正在读取图片
      </div>
    );
  }
  if (!ticket.data) return <ProductError error={ticket.error} />;
  return <img className="kb2-data-image" src={ticket.data.url} alt={props.alt} />;
}

function InfoRow(props: { label: string; value: string }) {
  return (
    <div className="kb2-info-line">
      <span>{props.label}</span>
      <strong title={props.value}>{props.value}</strong>
    </div>
  );
}

function segmentStatusView(status: string) {
  if (status === 'indexed') return { label: '已索引', tone: 'success' as const };
  if (status === 'error' || status === 'rebuild_failed')
    return { label: '索引异常', tone: 'danger' as const };
  if (status === 'rebuilding') return { label: '重建索引中', tone: 'purple' as const };
  if (status === 'indexing') return { label: '索引中', tone: 'info' as const };
  return { label: '待索引', tone: 'neutral' as const };
}

function formatTagValue(value: unknown) {
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
