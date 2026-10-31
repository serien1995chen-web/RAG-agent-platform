'use client';

import { Box, Flex, Text } from '@chakra-ui/react';
import { useEffect, useRef } from 'react';
import type { S10UsageSummary } from '../client/s10-ops-client';
import { KnowledgeDataTable } from './data-table';
import { useKnowledgeI18n } from '../i18n';
import { EmptyState, ProblemNotice, Section, StatusTag } from './knowledge-primitives';

function usageChartOption(summary: S10UsageSummary) {
  return {
    animation: false,
    grid: { left: 44, right: 16, top: 24, bottom: 30 },
    tooltip: { trigger: 'axis' },
    xAxis: {
      type: 'category',
      data: summary.series.map((point) => point.bucketStart.slice(0, 10)),
    },
    yAxis: { type: 'value' },
    series: [
      {
        type: 'line',
        name: 'pointsMicros',
        data: summary.series.map((point) => point.pointsMicros),
        symbol: 'none',
        lineStyle: { width: 2 },
        areaStyle: { opacity: 0.08 },
      },
    ],
  };
}

function UsageChart(props: { summary: S10UsageSummary }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!ref.current || props.summary.series.length === 0) return;
    let disposed = false;
    let chart: {
      setOption: (option: unknown) => void;
      resize: () => void;
      dispose: () => void;
    } | null = null;
    const observer = new ResizeObserver(() => chart?.resize());
    void import('echarts').then(({ init }) => {
      if (disposed || !ref.current) return;
      chart = init(ref.current, undefined, { renderer: 'canvas' });
      chart.setOption(usageChartOption(props.summary));
      observer.observe(ref.current);
    });
    return () => {
      disposed = true;
      observer.disconnect();
      chart?.dispose();
    };
  }, [props.summary]);
  return (
    <Box
      ref={ref}
      role="img"
      aria-label="Usage points chart"
      minH={{ base: '240px', md: '300px' }}
      borderWidth="1px"
      borderColor="kn.line"
      borderRadius="sm"
      p={2}
    />
  );
}

export function S10UsageDashboard(props: {
  summary?: S10UsageSummary;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const { t } = useKnowledgeI18n();
  if (props.error) {
    return <ProblemNotice error={props.error as Error} onRetry={props.onRetry} />;
  }
  if (props.loading || !props.summary) {
    return <Box className="loading-block">{t('common.loading')}</Box>;
  }
  const { summary } = props;
  if (summary.series.length === 0 && summary.usage.aiPointsMicros === 0) {
    return <EmptyState title={t('usage.emptyTitle')} description={t('usage.emptyDescription')} />;
  }
  return (
    <>
      <div className="metric-strip">
        {[
          [t('usage.points'), (summary.usage.aiPointsMicros / 1_000_000).toFixed(6)],
          [t('usage.inputTokens'), summary.usage.inputTokens],
          [t('usage.outputTokens'), summary.usage.outputTokens],
          [t('usage.pages'), summary.usage.parsePages],
          [t('usage.storage'), summary.usage.storageBytes],
          [t('usage.modelCalls'), summary.usage.modelCalls],
        ].map(([label, value]) => (
          <div className="metric" key={String(label)}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <Flex gap={2} mt={4} wrap="wrap">
        <Text m={0} fontSize="xs" color="kn.inkMuted" overflowWrap="anywhere">
          usage={summary.profileVersion}
        </Text>
        <Text m={0} fontSize="xs" color="kn.inkMuted" overflowWrap="anywhere">
          quota={summary.quota.profileVersion}
        </Text>
        <StatusTag value={`${t('usage.deliveryPending')} ${summary.delivery.pending}`} />
        <StatusTag value={`${t('usage.deliveryDelivered')} ${summary.delivery.delivered}`} />
        <StatusTag
          value={`${t('usage.deliveryFailed')} ${summary.delivery.failed}`}
          tone={summary.delivery.failed > 0 ? 'warning' : 'neutral'}
        />
      </Flex>
      <Section title={t('usage.chart')} meta={t('usage.chartMeta')}>
        <UsageChart summary={summary} />
      </Section>
      <Section title={t('usage.series')}>
        <Box minW={0} maxW="100%" overflowX="auto">
          <KnowledgeDataTable
            rows={summary.series}
            rowKey={(row) => row.bucketStart}
            empty={t('usage.noSeries')}
            caption={t('usage.series')}
            columns={[
              {
                key: 'bucket',
                label: t('usage.bucket'),
                render: (row) => <span className="mono">{row.bucketStart.slice(0, 10)}</span>,
              },
              {
                key: 'points',
                label: t('usage.points'),
                render: (row) => (row.pointsMicros / 1_000_000).toFixed(6),
              },
              { key: 'input', label: t('usage.inputTokens'), render: (row) => row.inputTokens },
              { key: 'output', label: t('usage.outputTokens'), render: (row) => row.outputTokens },
              { key: 'pages', label: t('usage.pages'), render: (row) => row.pages },
            ]}
          />
        </Box>
      </Section>
      <Text mt={4} color="kn.inkMuted" fontSize="xs">
        {t('usage.period', {
          from: summary.period.from.slice(0, 10),
          to: summary.period.to.slice(0, 10),
        })}
      </Text>
    </>
  );
}
