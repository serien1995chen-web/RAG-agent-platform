export function formatDateTime(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export function datasetTypeLabel(type?: string | null): string {
  if (type === 'folder') return '文件夹';
  if (type === 'knowledge' || type === 'dataset') return '知识库';
  return type || '—';
}

export function collectionTypeLabel(type?: string | null): string {
  const map: Record<string, string> = {
    file: '文件',
    link: '链接',
    folder: '文件夹',
    virtual: '空集合',
    images: '图片',
    image: '图片',
    externalFile: '外部文件',
    apiFile: 'API 文件',
  };
  return map[type ?? ''] ?? type ?? '—';
}

export function trainingStateLabel(state?: string | null): string {
  const map: Record<string, string> = {
    queued: '排队中',
    running: '训练中',
    ready: '已就绪',
    error: '训练失败',
  };
  return map[state ?? ''] ?? (state || '未知');
}

export function trainingTone(state?: string | null): 'ok' | 'warn' | 'err' | 'muted' {
  if (state === 'ready') return 'ok';
  if (state === 'error') return 'err';
  if (state === 'queued' || state === 'running') return 'warn';
  return 'muted';
}

export function modeLabel(mode?: string | null): string {
  const map: Record<string, string> = {
    chunk: '分段',
    qa: '问答',
    image: '图片',
    imageParse: '图片理解',
  };
  return map[mode ?? ''] ?? (mode || '—');
}

export function permanentLabel(mask?: number): string {
  if (mask === undefined) return '—';
  if (mask === 15) return '全部权限 (15)';
  if (mask === 0) return '无显式权限 (0)';
  return String(mask);
}
