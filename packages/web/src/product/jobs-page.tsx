'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { controlJob, listJobs, type JobControlAction } from './api';
import { sourceStatusView } from './dataset-detail-state';
import { ProductAppShell } from './shell';
import type { Job } from './types';
import {
  ProductButton,
  ProductEmpty,
  ProductError,
  ProductPage,
  ProductPageHeader,
  ProductSelect,
  ProductSkeleton,
  StatusTag,
} from './ui';

const ACTIVE_STATES = new Set(['queued', 'leased', 'running', 'retry_wait', 'paused']);
const ACTION_LABEL: Record<JobControlAction, string> = {
  retry: '重试',
  cancel: '取消',
  pause: '暂停',
  resume: '恢复',
  replay: '重新投递',
};

function actionsFor(job: Job): JobControlAction[] {
  const actions: JobControlAction[] = [];
  if (['failed', 'dead_letter'].includes(job.status)) actions.push('retry');
  if (['queued', 'leased', 'running', 'paused', 'retry_wait'].includes(job.status)) {
    actions.push('cancel');
  }
  if (job.status === 'queued' || job.status === 'running') actions.push('pause');
  if (job.status === 'paused') actions.push('resume');
  return actions;
}

function stepErrorOf(job: Job) {
  return job.steps?.find((step) => step.error)?.error;
}

export function JobsPage(props: { spaceId: string }) {
  const [status, setStatus] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const jobsQuery = useQuery({
    queryKey: ['kb-product', 'jobs-center', props.spaceId],
    queryFn: listJobs,
    enabled: Boolean(props.spaceId),
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
  });
  const jobs = useMemo(
    () =>
      (jobsQuery.data ?? [])
        .filter((job) => job.knowledgeSpaceId === props.spaceId)
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)),
    [jobsQuery.data, props.spaceId],
  );
  const visible = status ? jobs.filter((job) => job.status === status) : jobs;
  const active = jobs.filter((job) => ACTIVE_STATES.has(job.status)).length;
  const failed = jobs.filter((job) => ['failed', 'dead_letter'].includes(job.status)).length;
  const selected = jobs.find((job) => job.jobId === selectedId) ?? null;

  const runAction = async (action: JobControlAction, job: Job) => {
    setBusy(`${action}:${job.jobId}`);
    setActionError(null);
    try {
      await controlJob(action, job);
      await jobsQuery.refetch();
    } catch (error) {
      setActionError(error);
    } finally {
      setBusy(null);
    }
  };

  return (
    <ProductAppShell active="knowledge" title="任务中心">
      <ProductPage className="kb2-jobs-page">
        <ProductPageHeader
          title="任务中心"
          description="查看任务阶段、进度、重试状态和执行租约。"
          breadcrumbs={
            <a href={`/dataset/detail?datasetId=${encodeURIComponent(props.spaceId)}`}>
              返回知识库
            </a>
          }
          actions={
            <a
              className="kb2-button kb2-button--secondary"
              href={`/dataset/detail?datasetId=${encodeURIComponent(props.spaceId)}`}
            >
              查看文件
            </a>
          }
        />
        <div className="kb2-jobs-summary" aria-label="任务概览">
          <div>
            <strong>{jobs.length}</strong>
            <span>全部任务</span>
          </div>
          <div>
            <strong>{active}</strong>
            <span>活动任务</span>
          </div>
          <div>
            <strong>{failed}</strong>
            <span>待处理异常</span>
          </div>
        </div>
        <div className="kb2-jobs-toolbar">
          <label>
            任务状态
            <ProductSelect value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">全部状态</option>
              {[
                'queued',
                'leased',
                'running',
                'retry_wait',
                'paused',
                'failed',
                'dead_letter',
                'succeeded',
                'cancelled',
              ].map((value) => (
                <option key={value} value={value}>
                  {sourceStatusView(value).label}
                </option>
              ))}
            </ProductSelect>
          </label>
          <span>{visible.length} 个结果</span>
        </div>
        <ProductError error={actionError ?? jobsQuery.error} />
        {jobsQuery.isLoading ? (
          <ProductSkeleton rows={5} />
        ) : visible.length === 0 ? (
          <ProductEmpty
            title="暂无任务"
            description="从文件导入或索引操作创建任务后，可在这里查看。"
          />
        ) : (
          <div className="kb2-jobs-layout">
            <div className="kb2-jobs-list" aria-label="任务列表">
              {visible.map((job) => {
                const statusView = sourceStatusView(job.status);
                return (
                  <button
                    type="button"
                    className={`kb2-job-row${selected?.jobId === job.jobId ? ' is-selected' : ''}`}
                    key={job.jobId}
                    onClick={() => setSelectedId(job.jobId)}
                    aria-pressed={selected?.jobId === job.jobId}
                  >
                    <span className="kb2-job-row__kind">{job.kind}</span>
                    <span className="kb2-job-row__id">{job.jobId}</span>
                    <StatusTag value={statusView.label} tone={statusView.tone} />
                    <span className="kb2-job-row__progress">
                      {job.progress.stage} · {job.progress.percent}%
                    </span>
                  </button>
                );
              })}
            </div>
            <aside className="kb2-job-detail" aria-label="任务详情">
              {selected ? (
                <>
                  <div className="kb2-job-detail__header">
                    <div>
                      <span>{selected.kind}</span>
                      <h2>{selected.jobId}</h2>
                    </div>
                    <StatusTag
                      value={sourceStatusView(selected.status).label}
                      tone={sourceStatusView(selected.status).tone}
                      dot
                    />
                  </div>
                  <dl className="kb2-job-metadata">
                    <div>
                      <dt>进度</dt>
                      <dd>
                        {selected.progress.completed}/{selected.progress.total} ·{' '}
                        {selected.progress.percent}%
                      </dd>
                    </div>
                    <div>
                      <dt>尝试</dt>
                      <dd>
                        {selected.attempts}/{selected.maxAttempts}
                      </dd>
                    </div>
                    <div>
                      <dt>执行 epoch</dt>
                      <dd>{selected.attemptEpoch ?? 0}</dd>
                    </div>
                    <div>
                      <dt>租约所有者</dt>
                      <dd>{selected.leaseOwner ?? '无'}</dd>
                    </div>
                  </dl>
                  <div className="kb2-progress-track">
                    <span
                      style={{
                        width: `${Math.max(0, Math.min(100, selected.progress.percent))}%`,
                      }}
                    />
                  </div>
                  <h3>步骤</h3>
                  {selected.steps?.length ? (
                    <ol className="kb2-job-steps">
                      {selected.steps.map((step, index) => (
                        <li key={`${String(step.stepKey ?? 'step')}-${index}`}>
                          <strong>{String(step.stepKey ?? 'step')}</strong>
                          <span>{String(step.status ?? 'pending')}</span>
                          {step.error ? <code>{JSON.stringify(step.error)}</code> : null}
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="kb2-note">任务尚未产生步骤记录。</p>
                  )}
                  {selected.error || stepErrorOf(selected) ? (
                    <div className="kb2-error-panel">
                      <div>
                        <strong>
                          {String(
                            selected.error?.code ??
                              (stepErrorOf(selected) as { code?: string } | undefined)?.code ??
                              '任务失败',
                          )}
                        </strong>
                        <span>错误按任务和步骤保留，刷新后仍可查看。</span>
                      </div>
                    </div>
                  ) : null}
                  <div className="kb2-job-actions">
                    {actionsFor(selected).map((action) => (
                      <ProductButton
                        key={action}
                        busy={busy === `${action}:${selected.jobId}`}
                        tone={action === 'cancel' ? 'danger' : 'secondary'}
                        onClick={() => void runAction(action, selected)}
                      >
                        {ACTION_LABEL[action]}
                      </ProductButton>
                    ))}
                  </div>
                </>
              ) : (
                <ProductEmpty title="选择一个任务" description="查看进度、步骤、租约与异常。" />
              )}
            </aside>
          </div>
        )}
      </ProductPage>
    </ProductAppShell>
  );
}
