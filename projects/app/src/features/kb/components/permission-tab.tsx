import { useState } from 'react';
import { kbApi } from '../lib/kb-api';
import { permanentLabel } from '../lib/format';
import { useKbResource } from '../lib/use-kb-resource';
import type { Collaborator } from '../types';
import styles from '../styles/kb.module.css';
import { Badge, Button, ConfirmDialog, EmptyState, InlineError, Spinner } from './ui';

export function PermissionTab({
  datasetId,
  datasetName,
}: {
  datasetId: string;
  datasetName: string;
}) {
  const permission = useKbResource(datasetId, () => kbApi.getPermission(datasetId));
  const collaborators = useKbResource<{
    list?: Collaborator[];
    collaborators?: Collaborator[];
    version?: number;
  }>(datasetId, () =>
    kbApi.listCollaborators(datasetId).catch(() => ({ list: [] as Collaborator[] })),
  );
  const [confirmResume, setConfirmResume] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const inherited = permission.data?.inherited ?? permission.data?.inheritEnabled ?? false;
  const collaboratorList =
    collaborators.data?.list ??
    collaborators.data?.collaborators ??
    permission.data?.collaboratorSummary ??
    [];

  const resumeInherit = async () => {
    const version = permission.data?.version;
    if (!version) return;
    setBusy(true);
    setError(null);
    try {
      await kbApi.resumeInherit(datasetId, version);
      setConfirmResume(false);
      permission.reload();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <h3 className={styles.sectionTitle}>权限快照</h3>
        <div className={styles.sectionActions}>
          <Button icon="refresh" onClick={permission.reload} loading={permission.loading}>
            刷新
          </Button>
          {!inherited ? (
            <Button variant="primary" onClick={() => setConfirmResume(true)}>
              恢复继承
            </Button>
          ) : null}
        </div>
      </div>
      {permission.loading && !permission.data ? <Spinner label="读取权限" /> : null}
      {permission.error ? (
        <InlineError error={permission.error} onRetry={permission.reload} />
      ) : null}
      {error ? <InlineError error={error} /> : null}
      {permission.data ? (
        <div className={styles.detailMeta}>
          <span className={styles.detailMetaItem}>
            Owner <span className={styles.mono}>{permission.data.owner ?? '—'}</span>
          </span>
          <span className={styles.detailMetaItem}>
            权限位{' '}
            <span className={styles.mono}>{permanentLabel(permission.data.permissionMask)}</span>
          </span>
          <span className={styles.detailMetaItem}>
            继承 <Badge tone={inherited ? 'ok' : 'muted'}>{inherited ? '已继承' : '未继承'}</Badge>
          </span>
          <span className={styles.detailMetaItem}>
            版本 <span className={styles.mono}>{permission.data.version ?? '—'}</span>
          </span>
          <span className={styles.detailMetaItem}>
            来源 <span className={styles.mono}>{permission.data.source ?? '—'}</span>
          </span>
        </div>
      ) : null}

      <div className={styles.divider} />
      <div className={styles.sectionHead}>
        <h3 className={styles.sectionTitle}>协作者</h3>
        <Badge tone="muted">只读</Badge>
      </div>
      {collaborators.loading && !collaborators.data ? <Spinner label="读取协作者" /> : null}
      {collaborators.error ? (
        <InlineError error={collaborators.error} onRetry={collaborators.reload} />
      ) : null}
      {collaboratorList.length === 0 ? (
        <EmptyState
          title="当前没有协作者记录"
          hint="当前环境使用固定开发身份；协作者管理需等待身份模块完善。"
        />
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>类型</th>
              <th>成员 ID</th>
              <th>权限位</th>
            </tr>
          </thead>
          <tbody>
            {collaboratorList.map((item) => (
              <tr key={`${item.collaboratorType}:${item.collaboratorId}`}>
                <td data-label="类型">{item.collaboratorType}</td>
                <td data-label="成员 ID">
                  <span className={styles.mono}>{item.collaboratorId}</span>
                </td>
                <td data-label="权限位">{permanentLabel(item.permissionMask)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {confirmResume ? (
        <ConfirmDialog
          title="恢复权限继承"
          target={datasetName}
          impact="将丢弃当前显式权限快照并恢复父级继承；协作者权限会随继承规则变化。"
          confirmLabel="恢复继承"
          busy={busy}
          danger={false}
          onCancel={() => setConfirmResume(false)}
          onConfirm={() => void resumeInherit()}
        />
      ) : null}
    </div>
  );
}
