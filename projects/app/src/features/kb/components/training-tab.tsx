import { useState } from 'react';
import { KbRequestError, kbApi, modelMode } from '../lib/kb-api';
import { formatDateTime, modeLabel } from '../lib/format';
import { useKbResource } from '../lib/use-kb-resource';
import type { TrainingErrorItem } from '../types';
import styles from '../styles/kb.module.css';
import {
  Badge,
  Button,
  Drawer,
  EmptyState,
  Field,
  InlineError,
  Input,
  Notice,
  Spinner,
  StatusBadge,
} from './ui';

export function TrainingTab({
  datasetId,
  onOpenCollection,
}: {
  datasetId: string;
  onOpenCollection: (collectionId: string) => void;
}) {
  const [resumeTask, setResumeTask] = useState<TrainingErrorItem | null>(null);
  const [detailTask, setDetailTask] = useState<TrainingErrorItem | null>(null);
  const queue = useKbResource(datasetId, () => kbApi.trainingQueue(datasetId));
  const hasError = useKbResource(datasetId, () => kbApi.trainingHasError(datasetId));
  const errors = useKbResource(datasetId, () =>
    kbApi.trainingErrors(datasetId).catch((caught: unknown) => {
      if (caught instanceof KbRequestError && caught.payload.code === 501070) {
        return { total: 0, list: [] };
      }
      throw caught;
    }),
  );
  const modes = queue.data?.modes ?? [];
  const list = errors.data?.list ?? [];
  const backlog = modes.some((item) => item.depth > 0 && item.running === 0);

  return (
    <div className={styles.section}>
      {modelMode() === 'mock' ? (
        <Notice tone="info">Mock 模型：训练仅验证解析、切分、向量与任务链路。</Notice>
      ) : null}
      {backlog ? (
        <Notice tone="warn">
          队列有积压且没有运行中的任务；请确认 Worker 已启动，不要把 queued 当作已就绪。
        </Notice>
      ) : null}
      <div className={styles.trainingGrid}>
        <section className={styles.panel}>
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle}>队列概览</h3>
            <div className={styles.sectionActions}>
              <Badge tone={hasError.data?.hasError ? 'err' : 'ok'}>
                {hasError.data?.hasError ? '存在错误' : '无训练错误'}
              </Badge>
              <Button
                size="sm"
                icon="refresh"
                onClick={() => {
                  queue.reload();
                  hasError.reload();
                  errors.reload();
                }}
                loading={queue.loading}
              >
                刷新
              </Button>
            </div>
          </div>
          {queue.loading && !queue.data ? <Spinner label="读取队列" /> : null}
          {queue.error ? <InlineError error={queue.error} onRetry={queue.reload} /> : null}
          {queue.data && modes.length === 0 ? (
            <EmptyState title="队列为空" hint="当前数据集没有排队或运行中的训练任务。" />
          ) : null}
          {modes.length > 0 ? (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>模式</th>
                  <th>排队</th>
                  <th>运行中</th>
                </tr>
              </thead>
              <tbody>
                {modes.map((item) => (
                  <tr key={item.mode}>
                    <td data-label="模式">{modeLabel(item.mode)}</td>
                    <td data-label="排队">{item.depth}</td>
                    <td data-label="运行中">{item.running}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </section>
        <section className={styles.panel}>
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle}>训练错误</h3>
          </div>
          {errors.loading && !errors.data ? <Spinner label="读取错误" /> : null}
          {errors.error ? <InlineError error={errors.error} onRetry={errors.reload} /> : null}
          {errors.data && list.length === 0 ? (
            <EmptyState
              title="没有错误记录"
              hint="训练失败的任务会出现在这里；可查看错误、恢复或跳转到集合。"
            />
          ) : null}
          {list.length > 0 ? (
            <div className={styles.stack}>
              {list.map((item, index) => (
                <div key={`${item.taskId ?? item.jobId ?? index}`} className={styles.errorRow}>
                  <div className={styles.inline}>
                    <StatusBadge state={item.state} />
                    <Badge tone="muted">{modeLabel(item.mode)}</Badge>
                    {item.retryCount !== undefined ? (
                      <span className={styles.muted}>重试预算 {item.retryCount}</span>
                    ) : null}
                  </div>
                  <div className={styles.preWrap}>{item.errorMsg ?? '无错误详情'}</div>
                  <div className={styles.rowActions}>
                    {item.taskId ? (
                      <Button size="sm" onClick={() => setDetailTask(item)}>
                        任务详情
                      </Button>
                    ) : null}
                    {item.collectionId ? (
                      <Button size="sm" onClick={() => onOpenCollection(item.collectionId ?? '')}>
                        查看集合
                      </Button>
                    ) : null}
                    {item.state === 'failed' && item.taskId ? (
                      <Button size="sm" variant="primary" onClick={() => setResumeTask(item)}>
                        恢复任务
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      </div>
      {resumeTask?.taskId ? (
        <ResumeDrawer
          task={resumeTask}
          onClose={() => setResumeTask(null)}
          onResumed={() => {
            errors.reload();
            queue.reload();
          }}
        />
      ) : null}
      {detailTask?.taskId ? (
        <TaskDetailDrawer task={detailTask} onClose={() => setDetailTask(null)} />
      ) : null}
    </div>
  );
}

function ResumeDrawer({
  task,
  onClose,
  onResumed,
}: {
  task: TrainingErrorItem;
  onClose: () => void;
  onResumed: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async () => {
    if (!task.taskId || !reason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await kbApi.resumeTraining(task.taskId, reason.trim());
      onResumed();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer
      title="恢复训练任务"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            loading={busy}
            disabled={!reason.trim()}
          >
            恢复
          </Button>
        </>
      }
    >
      {error ? <InlineError error={error} /> : null}
      <Field label="恢复原因" required hint="恢复会重置重试预算；请说明原因以便审计。">
        <Input autoFocus value={reason} onChange={(event) => setReason(event.target.value)} />
      </Field>
    </Drawer>
  );
}

function TaskDetailDrawer({ task, onClose }: { task: TrainingErrorItem; onClose: () => void }) {
  const resource = useKbResource(`task:${task.taskId}`, () =>
    kbApi.trainingDetail(task.taskId ?? ''),
  );
  return (
    <Drawer title="训练任务" onClose={onClose} footer={<Button onClick={onClose}>关闭</Button>}>
      {resource.loading ? <Spinner label="读取任务" /> : null}
      {resource.error ? <InlineError error={resource.error} onRetry={resource.reload} /> : null}
      {resource.data ? (
        <div className={styles.stack}>
          <div className={styles.inline}>
            <StatusBadge state={task.state} />
            <Badge tone="muted">{modeLabel(task.mode)}</Badge>
          </div>
          <div className={styles.mono}>{task.taskId}</div>
          <div>
            <span className={styles.muted}>错误</span>
            <div className={styles.preWrap}>{task.errorMsg ?? '—'}</div>
          </div>
          <div>
            <span className={styles.muted}>更新时间</span>
            <div>{formatDateTime(task.lockTime)}</div>
          </div>
          <details className={styles.diagnostics}>
            <summary>任务详情</summary>
            <pre>{JSON.stringify(resource.data, null, 2)}</pre>
          </details>
        </div>
      ) : null}
    </Drawer>
  );
}
