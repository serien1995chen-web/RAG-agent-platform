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
import type { BatchResult, KnowledgeSpace, Segment } from './types';
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
  const [indexDrafts, setIndexDrafts] = useState<Record<string, string>>({});
  const [indexBusy, setIndexBusy] = useState(false);
  const [indexError, setIndexError] = useState<unknown>(null);
  const [deleteTarget, setDeleteTarget] = useState<Segment | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<unknown>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchError, setBatchError] = useState<unknown>(null);
  const [batchResult, setBatchResult] = useState<BatchResult | null>(null);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [batchDeleteText, setBatchDeleteText] = useState('');
  const [capabilityMessage, setCapabilityMessage] = useState('');

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

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['kb-product', 'source', props.sourceId] }),
      queryClient.invalidateQueries({ queryKey: ['kb-product', 'segments', props.sourceId] }),
      queryClient.invalidateQueries({
        queryKey: ['kb-product', 'sources', source?.knowledgeSpaceId],
      }),
      queryClient.invalidateQueries({ queryKey: ['kb-product', 'jobs'] }),
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
    setIndexDrafts({});
    setEditorError(null);
    setIndexError(null);
    setEditorOpen(true);
  };

  const openEdit = (segment: Segment) => {
    if (['pending', 'indexing', 'rebuilding', 'rebuild_failed'].includes(segment.indexStatus)) {
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
    setEditorOpen(true);
  };

  const saveSegment = async (event: FormEvent) => {
    event.preventDefault();
    if (!question.trim()) return;
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
          searchEnabled,
        });
      }
      await invalidate();
      setEditorOpen(false);
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
          <ProductButton tone="ghost" onClick={() => setSelectedIds([])}>
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
          </form>
          <aside className="kb2-index-panel">
            <div className="kb2-index-panel__head">
              <h3>索引 {editingSegment?.indexes.length ?? 0}</h3>
              <span>系统索引只读</span>
            </div>
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
            {editingSegment ? (
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
                  onClick={() => void addIndex()}
                >
                  添加索引
                </ProductButton>
                <ProductError error={indexError} />
              </div>
            ) : (
              <div className="kb2-table-muted">新数据保存后可继续管理索引。</div>
            )}
          </aside>
        </div>
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
