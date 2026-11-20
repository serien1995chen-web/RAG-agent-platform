export interface B16Topic {
  id: string;
  language: 'zh' | 'en';
  label: string;
  anchor: string;
  related: string;
}

export interface B16SegmentFixture {
  segmentId: string;
  sourceId: string;
  topicId: string;
  language: 'zh' | 'en';
  text: string;
  anchor: string;
}

export interface B16QueryFixture {
  queryId: string;
  segmentId: string;
  query: string;
  relevantSegmentIds: string[];
}

const TOPICS: readonly B16Topic[] = [
  {
    id: 'refund',
    language: 'en',
    label: 'Refund processing',
    anchor: 'refund matrix',
    related: 'Refunds are reviewed by the payments team within five business days.',
  },
  {
    id: 'invoice',
    language: 'en',
    label: 'Invoice correction',
    anchor: 'invoice delta',
    related: 'Invoice corrections require the taxable amount and purchase order number.',
  },
  {
    id: 'security',
    language: 'en',
    label: 'Account security',
    anchor: 'security beacon',
    related: 'Suspicious sign-ins are isolated until the account owner confirms the device.',
  },
  {
    id: 'logistics',
    language: 'zh',
    label: '物流延误',
    anchor: '物流灯塔',
    related: '物流延误超过四十八小时时，需要登记承运商与运单号。',
  },
  {
    id: 'warranty',
    language: 'zh',
    label: '保修申请',
    anchor: '保修星标',
    related: '保修申请需提交购买凭证和故障现象，审核周期为三个工作日。',
  },
  {
    id: 'subscription',
    language: 'en',
    label: 'Subscription renewal',
    anchor: 'renewal compass',
    related: 'Subscription renewals are paused when the billing contact is missing.',
  },
  {
    id: 'privacy',
    language: 'zh',
    label: '隐私删除',
    anchor: '隐私罗盘',
    related: '隐私删除请求完成后，关联缓存将在二十四小时内失效。',
  },
  {
    id: 'shipping',
    language: 'en',
    label: 'Shipping address',
    anchor: 'address quartz',
    related: 'Shipping address changes are locked once the parcel enters dispatch.',
  },
  {
    id: 'quality',
    language: 'zh',
    label: '质量复核',
    anchor: '质量棱镜',
    related: '质量复核会比对批次编号、检验记录和供应商报告。',
  },
  {
    id: 'escalation',
    language: 'en',
    label: 'Support escalation',
    anchor: 'escalation compass',
    related: 'Support escalation requires the original ticket, impact and attempted fixes.',
  },
] as const;

const FORMATS = [
  (topic: B16Topic, index: number) =>
    `${topic.anchor.toUpperCase()} ${String(index).padStart(3, '0')}: ${topic.related}`,
  (topic: B16Topic, index: number) =>
    `Case ${index + 1}. ${topic.related} Reference: ${topic.anchor}.`,
  (topic: B16Topic, index: number) => `${topic.related} 备注：${topic.anchor} #${index + 1}。`,
  (topic: B16Topic, index: number) => `“${topic.anchor}” (${index + 1}) — ${topic.related}`,
] as const;

export const B16_SEGMENTS: readonly B16SegmentFixture[] = Array.from(
  { length: 100 },
  (_, index) => {
    const topic = TOPICS[index % TOPICS.length]!;
    const ordinal = Math.floor(index / TOPICS.length) + 1;
    const anchor = `${topic.anchor}-${String(index + 1).padStart(3, '0')}`;
    const text = FORMATS[index % FORMATS.length]!(topic, index);
    return {
      segmentId: `kb-b16-a-seg-${String(index + 1).padStart(3, '0')}`,
      sourceId: `kb-b16-a-src-${String((index % 10) + 1).padStart(2, '0')}`,
      topicId: `${topic.id}-${ordinal}`,
      language: topic.language,
      text: `${text} anchor=${anchor}; topic=${topic.label}.`,
      anchor,
    };
  },
);

export const B16_QUERIES: readonly B16QueryFixture[] = B16_SEGMENTS.map((segment, index) => {
  const topic = TOPICS[index % TOPICS.length]!;
  return {
    queryId: `kb-b16-a-query-${String(index + 1).padStart(3, '0')}`,
    segmentId: segment.segmentId,
    query:
      segment.language === 'zh'
        ? `${topic.anchor} ${topic.related.slice(0, 18)}`
        : `${topic.anchor} ${topic.related.split(' ').slice(0, 6).join(' ')}`,
    relevantSegmentIds: B16_SEGMENTS.filter(
      (candidate) => candidate.topicId === segment.topicId,
    ).map((candidate) => candidate.segmentId),
  };
});

export function deterministicVector(dimension: 768 | 1024 | 1536 | 3072, segmentIndex: number) {
  const topicIndex = segmentIndex % TOPICS.length;
  return Array.from({ length: dimension }, (_, axis) => {
    const primary = axis % TOPICS.length === topicIndex ? 1 : 0;
    const harmonic = Math.sin((segmentIndex + 1) * (axis + 1) * 0.0001) * 0.01;
    return primary + harmonic;
  });
}

export function fixtureSeedHashInput() {
  return JSON.stringify({
    seed: 'kb-b16-a-20261120',
    segments: B16_SEGMENTS,
    queries: B16_QUERIES,
  });
}
