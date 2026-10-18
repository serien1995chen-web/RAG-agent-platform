import { Fragment, useMemo, useState } from 'react';
import { DemoShell } from '../../../../demo/kb/components/demo-shell';
import { EmptyState, SeverityBadge, severityRank } from '../../../../demo/kb/components/primitives';
import { useDemoStore } from '../../../../demo/kb/lib/use-demo-store';
import styles from '../../../../demo/kb/styles/demo.module.css';
import type { Defect } from '../../../../demo/kb/types';

function download(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function toMarkdown(defects: Defect[]): string {
  const lines = ['# 知识库 Demo 缺陷记录', '', `导出时间：${new Date().toISOString()}`, ''];
  for (const defect of [...defects].sort(
    (a, b) => severityRank[a.severity] - severityRank[b.severity],
  )) {
    lines.push(`## ${defect.id} ${defect.title}`, '');
    lines.push(`- 严重度：${defect.severity}`);
    lines.push(`- 区域：${defect.area}`);
    lines.push(`- 分类：${defect.category}`);
    lines.push(`- requestId：${defect.requestId ?? '—'}`);
    lines.push(`- 关联调用：#${String(defect.runEntryRef).padStart(3, '0')}`);
    lines.push(`- 发生时间：${defect.createdAt}`);
    lines.push(`- 期望：${defect.expected}`);
    lines.push(`- 实际：${defect.actual}`);
    lines.push('- 复现步骤：');
    defect.steps.forEach((step, index) => lines.push(`  ${index + 1}. ${step}`));
    if (defect.note) lines.push(`- 备注：${defect.note}`);
    lines.push('');
  }
  return lines.join('\n');
}

export default function DemoDefectsPage() {
  const { defects, runs } = useDemoStore();
  const [expanded, setExpanded] = useState<string | null>(null);

  const sorted = useMemo(
    () => [...defects].sort((a, b) => severityRank[a.severity] - severityRank[b.severity]),
    [defects],
  );
  const bySeverity = (severity: Defect['severity']) =>
    defects.filter((item) => item.severity === severity).length;

  return (
    <DemoShell
      title="缺陷记录"
      breadcrumb={`${defects.length} 条 · 全部来自真实失败调用`}
      actions={
        <>
          <button
            type="button"
            className={styles.button}
            disabled={defects.length === 0}
            onClick={() =>
              download(
                'kb-demo-defects.json',
                JSON.stringify(
                  { exportedAt: new Date().toISOString(), runs, defects: sorted },
                  null,
                  2,
                ),
                'application/json',
              )
            }
          >
            导出 JSON
          </button>
          <button
            type="button"
            className={styles.button}
            disabled={defects.length === 0}
            onClick={() => download('kb-demo-defects.md', toMarkdown(sorted), 'text/markdown')}
          >
            导出 Markdown
          </button>
        </>
      }
    >
      <div className={`${styles.panel} ${styles.panelPad} ${styles.mb12}`}>
        <div className={styles.flex}>
          <span className={`${styles.badge} ${styles.badgeErr}`}>阻断 {bySeverity('blocker')}</span>
          <span className={`${styles.badge} ${styles.badgeErr}`}>高 {bySeverity('high')}</span>
          <span className={`${styles.badge} ${styles.badgeWarn}`}>中 {bySeverity('medium')}</span>
          <span className={`${styles.badge} ${styles.badgeMuted}`}>低 {bySeverity('low')}</span>
        </div>
      </div>

      {defects.length === 0 ? (
        <EmptyState
          title="还没有缺陷记录"
          hint="在运行脊柱里点开任意失败调用，选择“记录为缺陷”。"
        />
      ) : (
        <section className={`${styles.panel} ${styles.panelPad}`}>
          <table className={`${styles.table} ${styles.tableCardMode}`}>
            <thead>
              <tr>
                <th>ID</th>
                <th>标题</th>
                <th>严重度</th>
                <th>区域</th>
                <th>requestId</th>
                <th>时间</th>
                <th className={styles.right}>操作</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((defect) => (
                <Fragment key={defect.id}>
                  <tr>
                    <td data-label="ID" className={styles.mono}>
                      {defect.id}
                    </td>
                    <td data-label="标题">{defect.title}</td>
                    <td data-label="严重度">
                      <SeverityBadge severity={defect.severity} />
                    </td>
                    <td data-label="区域">{defect.area}</td>
                    <td data-label="requestId" className={`${styles.mono} ${styles.tiny}`}>
                      {defect.requestId ?? '—'}
                    </td>
                    <td data-label="时间" className={styles.tiny}>
                      {new Date(defect.createdAt).toLocaleString('zh-CN')}
                    </td>
                    <td data-label="操作" className={styles.right}>
                      <button
                        type="button"
                        className={`${styles.button} ${styles.buttonSmall}`}
                        onClick={() => setExpanded(expanded === defect.id ? null : defect.id)}
                      >
                        {expanded === defect.id ? '收起' : '展开'}
                      </button>
                    </td>
                  </tr>
                  {expanded === defect.id ? (
                    <tr>
                      <td colSpan={7}>
                        <div className={styles.kv}>
                          <span className={styles.kvKey}>分类</span>
                          <span className={styles.mono}>{defect.category}</span>
                          <span className={styles.kvKey}>期望</span>
                          <span>{defect.expected}</span>
                          <span className={styles.kvKey}>实际</span>
                          <span>{defect.actual}</span>
                          <span className={styles.kvKey}>关联调用</span>
                          <span className={styles.mono}>
                            #{String(defect.runEntryRef).padStart(3, '0')}
                          </span>
                        </div>
                        <ol className={styles.small} style={{ marginTop: 8 }}>
                          {defect.steps.map((step) => (
                            <li key={step}>{step}</li>
                          ))}
                        </ol>
                        {defect.note ? (
                          <div className={styles.tiny}>备注：{defect.note}</div>
                        ) : null}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </DemoShell>
  );
}
