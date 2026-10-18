import { useCallback, useEffect, useRef, useState } from 'react';
import { kbApi } from '../lib/kb-api';
import type { DeleteFailureList, DeleteJobData } from '../types';
import styles from '../styles/kb.module.css';
import { Badge, Button, Drawer, InlineError, Spinner } from './ui';

const JOB_LABEL: Record<string, string> = {
  marked: '已标记',
  queued: '排队中',
  deleting: '删除中',
  completed: '已完成',
  failed: '失败',
};

export function DeleteJobDrawer({
  jobId,
  onClose,
  onFinished,
}: {
  jobId: string;
  onClose: () => void;
  onFinished?: () => void;
}) {
  const [job, setJob] = useState<DeleteJobData | null>(null);
  const [failures, setFailures] = useState<DeleteFailureList | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [retrying, setRetrying] = useState(false);
  const finishedRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const [nextJob, nextFailures] = await Promise.all([
        kbApi.getDeleteJob(jobId),
        kbApi.listDeleteFailures(jobId).catch(() => null),
      ]);
      setJob(nextJob);
      setFailures(nextFailures);
      setError(null);
      if ((nextJob.state === 'completed' || nextJob.state === 'failed') && !finishedRef.current) {
        finishedRef.current = true;
        onFinished?.();
      }
    } catch (caught) {
      setError(caught);
    }
  }, [jobId, onFinished]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (job?.state === 'completed' || job?.state === 'failed') return;
      void load();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [load, job?.state]);

  const retry = async () => {
    setRetrying(true);
    try {
      await kbApi.retryDeleteJob(jobId);
      finishedRef.current = false;
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setRetrying(false);
    }
  };

  const terminal = job?.state === 'completed' || job?.state === 'failed';
  const tone = job?.state === 'completed' ? 'ok' : job?.state === 'failed' ? 'err' : 'warn';

  return (
    <Drawer
      title="删除任务"
      onClose={onClose}
      footer={
        <>
          {job?.state === 'failed' && (failures?.total ?? 0) > 0 ? (
            <Button variant="danger" onClick={() => void retry()} loading={retrying}>
              重试失败项
            </Button>
          ) : null}
          <Button onClick={onClose}>关闭</Button>
        </>
      }
    >
      {error ? <InlineError error={error} onRetry={() => void load()} /> : null}
      {!job && !error ? <Spinner label="读取任务状态" /> : null}
      {job ? (
        <div className={styles.stack}>
          <div className={styles.inline}>
            <Badge tone={tone}>{JOB_LABEL[job.state ?? ''] ?? job.state ?? '未知'}</Badge>
            <span className={styles.muted}>阶段 {job.stage ?? '—'}</span>
            <span className={styles.muted}>
              {typeof job.progress === 'number' ? `${job.progress}%` : '进度未知'}
            </span>
          </div>
          <div className={styles.progressBar}>
            <div
              className={styles.progressFill}
              style={{ width: `${Math.max(0, Math.min(100, job.progress ?? 0))}%` }}
            />
          </div>
          <div className={styles.mono}>{jobId}</div>
          {job.state === 'completed' ? (
            <div className={styles.muted}>资源已从知识库移除；存储清理任务已完成。</div>
          ) : null}
          {job.state === 'failed' ? (
            <div className={styles.muted}>
              删除未完全完成。失败项可重试；重试只处理已登记的资源。
            </div>
          ) : null}
          {!terminal ? <div className={styles.muted}>任务运行中，页面会自动刷新状态。</div> : null}
          <div className={styles.divider} />
          <div className={styles.sectionTitle}>失败项（{failures?.total ?? 0}）</div>
          {failures && failures.list.length > 0 ? (
            <div className={styles.stack}>
              {failures.list.map((item, index) => (
                <div key={`${item.resourceId ?? index}`} className={styles.stack}>
                  <div>
                    <span className={styles.mono}>{item.resourceType ?? 'resource'}</span>{' '}
                    <span className={styles.muted}>{item.reason ?? '未知原因'}</span>
                  </div>
                  <div className={styles.mono}>{item.resourceId ?? '—'}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className={styles.muted}>没有失败项。</div>
          )}
        </div>
      ) : null}
    </Drawer>
  );
}
