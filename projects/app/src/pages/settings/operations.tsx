import {
  KnowledgeDataTable,
  ProductAppShell,
  ProductButton,
  ProductEmpty,
  ProductError,
  ProductField,
  ProductInput,
  ProductPage,
  ProductPageHeader,
  ProductSelect,
  ProductSkeleton,
  S10AuditPanel,
  S10SystemStatus,
  S10UsageDashboard,
  StatusTag,
  auditPath,
  cleanup,
  ensureConsoleSession,
  knowledgeQueryKeys,
  knowledgeRequest,
  reconcile,
  usagePath,
  useKnowledgeQuery,
  type Job,
  type S10AuditFilters,
  type S10AuditList,
  type S10OpsJob,
  type S10Status,
  type S10UsageSummary,
} from '@kb/web';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useEffect, useMemo, useState } from 'react';

interface JobPage {
  items: Job[];
  pageInfo: { nextCursor: string | null; hasMore: boolean };
}

function queryValue(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 16);
}

function isoNow(): string {
  return new Date().toISOString().slice(0, 16);
}

function compactParams(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value.length > 0));
}

export default function OperationsPage() {
  const router = useRouter();
  const [admin, setAdmin] = useState<boolean | undefined>();
  const [usageDraft, setUsageDraft] = useState({
    from: queryValue(router.query.usageFrom) || isoDaysAgo(7),
    to: queryValue(router.query.usageTo) || isoNow(),
    type: queryValue(router.query.usageType),
    spaceId: queryValue(router.query.usageSpaceId),
  });
  const [jobStatus, setJobStatus] = useState(queryValue(router.query.jobStatus) || 'exceptions');
  const [jobBusy, setJobBusy] = useState<string | null>(null);
  const [jobError, setJobError] = useState<unknown>(null);
  const [statusBusy, setStatusBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void ensureConsoleSession()
      .then((session) => {
        if (active) setAdmin(session.scopes.includes('knowledge:admin'));
      })
      .catch(() => {
        if (active) setAdmin(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const usageParams = compactParams({
    from: queryValue(router.query.usageFrom),
    to: queryValue(router.query.usageTo),
    type: queryValue(router.query.usageType),
    spaceId: queryValue(router.query.usageSpaceId),
  });
  const auditFilters: S10AuditFilters = {
    action: queryValue(router.query.auditAction),
    actor: queryValue(router.query.auditActor),
    resourceType: queryValue(router.query.auditResourceType),
    resourceId: queryValue(router.query.auditResourceId),
    outcome: queryValue(router.query.auditOutcome),
    from: queryValue(router.query.auditFrom),
    to: queryValue(router.query.auditTo),
  };
  const auditParams = compactParams({
    action: auditFilters.action,
    actor: auditFilters.actor,
    resourceType: auditFilters.resourceType,
    resourceId: auditFilters.resourceId,
    outcome: auditFilters.outcome,
    from: auditFilters.from,
    to: auditFilters.to,
  });
  const enabled = admin === true;
  const usage = useKnowledgeQuery<S10UsageSummary>(
    knowledgeQueryKeys.usage.summary(usageParams),
    enabled ? usagePath(usageParams) : null,
  );
  const audit = useKnowledgeQuery<S10AuditList>(
    knowledgeQueryKeys.audit.list(auditParams),
    enabled ? auditPath(auditParams) : null,
  );
  const status = useKnowledgeQuery<S10Status>(
    knowledgeQueryKeys.operations.status,
    enabled ? '/v1/knowledge/operations/status' : null,
    { refetchInterval: 10_000 },
  );
  const jobs = useKnowledgeQuery<JobPage>(
    knowledgeQueryKeys.jobs.list({ limit: 200, sort: '-updatedAt' }),
    enabled ? '/v1/knowledge/jobs?limit=200&sort=-updatedAt' : null,
    { refetchInterval: 5_000 },
  );
  const visibleJobs = useMemo(() => {
    const rows = jobs.data?.items ?? [];
    if (jobStatus === 'exceptions') {
      return rows.filter((job) => ['failed', 'dead_letter', 'retry_wait'].includes(job.status));
    }
    if (jobStatus === 'all') return rows;
    return rows.filter((job) => job.status === jobStatus);
  }, [jobStatus, jobs.data?.items]);

  const applyUsageFilters = () => {
    void router.replace({
      pathname: router.pathname,
      query: compactParams({
        ...router.query,
        usageFrom: usageDraft.from,
        usageTo: usageDraft.to,
        usageType: usageDraft.type,
        usageSpaceId: usageDraft.spaceId,
      } as Record<string, string>),
    });
  };

  const runJobAction = async (job: Job, action: 'retry' | 'replay') => {
    setJobBusy(`${action}:${job.jobId}`);
    setJobError(null);
    try {
      await knowledgeRequest<Job>(`/v1/knowledge/jobs/${encodeURIComponent(job.jobId)}/${action}`, {
        method: 'POST',
        body: { version: job.version },
      });
      await jobs.refetch();
    } catch (error) {
      setJobError(error);
    } finally {
      setJobBusy(null);
    }
  };

  const submitCleanup = async (scope: string): Promise<S10OpsJob> => {
    setStatusBusy(true);
    try {
      return await cleanup(scope);
    } finally {
      setStatusBusy(false);
    }
  };

  const submitReconcile = async (scope: string, repair: boolean): Promise<S10OpsJob> => {
    setStatusBusy(true);
    try {
      return await reconcile(scope, repair);
    } finally {
      setStatusBusy(false);
    }
  };

  return (
    <ProductAppShell active="operations" title="运营与用量">
      <Head>
        <title>运营与用量 · 知识库</title>
      </Head>
      <ProductPage className="kb2-operations-page">
        <ProductPageHeader
          title="运营与用量"
          description="核对 Provider 调用、任务失败与重试、队列投递、依赖状态和运营恢复动作。"
        />
        {admin === undefined ? <ProductSkeleton rows={4} /> : null}
        {admin === false ? (
          <ProductEmpty
            title="需要管理员权限"
            description="全局用量、任务失败、死信和恢复操作仅对知识库管理员开放。"
          />
        ) : null}
        {enabled ? (
          <>
            <section className="kb2-ops-section" aria-labelledby="b20-usage-heading">
              <div className="kb2-ops-section__heading">
                <div>
                  <h2 id="b20-usage-heading">用量与投递</h2>
                  <p>按类型、Space 和时间范围核对点数、token、页面及 Outbox 投递状态。</p>
                </div>
              </div>
              <div className="filter-grid">
                <ProductField label="开始时间">
                  <ProductInput
                    type="datetime-local"
                    value={usageDraft.from}
                    onChange={(event) =>
                      setUsageDraft({ ...usageDraft, from: event.currentTarget.value })
                    }
                  />
                </ProductField>
                <ProductField label="结束时间">
                  <ProductInput
                    type="datetime-local"
                    value={usageDraft.to}
                    onChange={(event) =>
                      setUsageDraft({ ...usageDraft, to: event.currentTarget.value })
                    }
                  />
                </ProductField>
                <ProductField label="类型">
                  <ProductSelect
                    value={usageDraft.type}
                    onChange={(event) =>
                      setUsageDraft({ ...usageDraft, type: event.currentTarget.value })
                    }
                  >
                    <option value="">全部类型</option>
                    {['parse', 'ocr', 'embedding', 'rerank', 'llm', 'vlm', 'image', 'storage'].map(
                      (value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ),
                    )}
                  </ProductSelect>
                </ProductField>
                <ProductField label="Space ID">
                  <ProductInput
                    value={usageDraft.spaceId}
                    onChange={(event) =>
                      setUsageDraft({ ...usageDraft, spaceId: event.currentTarget.value })
                    }
                  />
                </ProductField>
                <ProductButton tone="primary" onClick={applyUsageFilters}>
                  应用筛选
                </ProductButton>
              </div>
              <S10UsageDashboard
                summary={usage.data}
                loading={usage.isLoading}
                error={usage.error}
                onRetry={() => void usage.refetch()}
              />
            </section>

            <section className="kb2-ops-section" aria-labelledby="b20-jobs-heading">
              <div className="kb2-ops-section__heading">
                <div>
                  <h2 id="b20-jobs-heading">任务失败与恢复</h2>
                  <p>识别 failed/dead_letter，保留原任务并进入重试或重放路径。</p>
                </div>
                <ProductField label="任务状态">
                  <ProductSelect
                    value={jobStatus}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setJobStatus(value);
                      void router.replace({
                        pathname: router.pathname,
                        query: compactParams({ ...router.query, jobStatus: value } as Record<
                          string,
                          string
                        >),
                      });
                    }}
                  >
                    <option value="all">全部状态</option>
                    <option value="exceptions">全部异常</option>
                    <option value="failed">failed</option>
                    <option value="dead_letter">dead_letter</option>
                    <option value="retry_wait">retry_wait</option>
                  </ProductSelect>
                </ProductField>
              </div>
              <ProductError error={jobError ?? jobs.error} onRetry={() => void jobs.refetch()} />
              {jobs.isLoading ? (
                <ProductSkeleton rows={3} />
              ) : (
                <KnowledgeDataTable
                  rows={visibleJobs}
                  rowKey={(job) => job.jobId}
                  empty="当前筛选下没有异常任务。"
                  caption="异常任务"
                  columns={[
                    {
                      key: 'job',
                      label: '任务',
                      render: (job) => <span className="mono">{job.jobId}</span>,
                    },
                    { key: 'kind', label: '类型', render: (job) => job.kind },
                    {
                      key: 'status',
                      label: '状态',
                      render: (job) => (
                        <StatusTag
                          value={job.status}
                          tone={
                            job.status === 'dead_letter' || job.status === 'failed'
                              ? 'danger'
                              : 'warning'
                          }
                        />
                      ),
                    },
                    {
                      key: 'attempts',
                      label: '尝试',
                      render: (job) => `${job.attempts}/${job.maxAttempts}`,
                    },
                    {
                      key: 'updated',
                      label: '更新时间',
                      render: (job) => job.updatedAt.slice(0, 19),
                    },
                    {
                      key: 'actions',
                      label: '操作',
                      render: (job) =>
                        job.status === 'failed' || job.status === 'dead_letter' ? (
                          <ProductButton
                            size="sm"
                            busy={
                              jobBusy ===
                              `${job.status === 'dead_letter' ? 'replay' : 'retry'}:${job.jobId}`
                            }
                            onClick={() =>
                              void runJobAction(
                                job,
                                job.status === 'dead_letter' ? 'replay' : 'retry',
                              )
                            }
                          >
                            {job.status === 'dead_letter' ? '重放' : '重试'}
                          </ProductButton>
                        ) : (
                          '—'
                        ),
                    },
                  ]}
                />
              )}
            </section>

            <section className="kb2-ops-section" aria-labelledby="b20-provider-heading">
              <div className="kb2-ops-section__heading">
                <div>
                  <h2 id="b20-provider-heading">Provider 调用明细</h2>
                  <p>从安全审计事实查看 Provider、类型、数量/单位、状态、尝试和 fallback。</p>
                </div>
              </div>
              <S10AuditPanel
                data={audit.data}
                loading={audit.isLoading}
                error={audit.error}
                filters={auditFilters}
                onFilters={(next) =>
                  void router.replace({
                    pathname: router.pathname,
                    query: compactParams({
                      ...router.query,
                      auditAction: next.action,
                      auditActor: next.actor,
                      auditResourceType: next.resourceType,
                      auditResourceId: next.resourceId,
                      auditOutcome: next.outcome,
                      auditFrom: next.from,
                      auditTo: next.to,
                    } as Record<string, string>),
                  })
                }
                onRetry={() => void audit.refetch()}
              />
            </section>

            <section className="kb2-ops-section" aria-labelledby="b20-system-heading">
              <div className="kb2-ops-section__heading">
                <div>
                  <h2 id="b20-system-heading">依赖、队列与对账</h2>
                  <p>检查 Provider 依赖、队列失败、死信压力和修复任务入口。</p>
                </div>
              </div>
              <S10SystemStatus
                status={status.data}
                loading={status.isLoading}
                error={status.error}
                busy={statusBusy}
                onRetry={() => void status.refetch()}
                onCleanup={submitCleanup}
                onReconcile={submitReconcile}
              />
            </section>
          </>
        ) : null}
      </ProductPage>
    </ProductAppShell>
  );
}
