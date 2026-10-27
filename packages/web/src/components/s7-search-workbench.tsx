'use client';

import {
  Alert,
  AlertDescription,
  AlertIcon,
  AlertTitle,
  Badge,
  Box,
  Button,
  Flex,
  Heading,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import { RepeatIcon } from '@chakra-ui/icons';
import type { SearchApiResponse, SearchFilterApi } from '@kb/contracts';
import { useEffect, useState } from 'react';
import type { S7SearchMode } from '../forms/s7-search-form';
import { S7CitationView, type S7CitationViewLabels } from './s7-citation-view';
import {
  S7SearchFilters,
  type S7SearchFiltersLabels,
  type S7SearchFormValue,
  type S7SpaceChoice,
  type S7TagChoice,
} from './s7-search-filters';
import { safeDegradedCode, type S7SearchUiState } from './s7-search-state';

export interface S7SearchWorkbenchLabels extends S7SearchFiltersLabels {
  title: string;
  description: string;
  results: string;
  loading: string;
  idle: string;
  empty: string;
  partial: string;
  degraded: string;
  permission: string;
  timeout: string;
  rateLimited: string;
  error: string;
  retry: string;
  trace: string;
  code: string;
  duration: string;
  resultCount: string;
  rerankApplied: string;
  citation: S7CitationViewLabels;
}

export interface S7SearchWorkbenchProps {
  mode: S7SearchMode;
  value: S7SearchFormValue;
  filters: SearchFilterApi;
  tags: readonly S7TagChoice[];
  spaces: readonly S7SpaceChoice[];
  result?: SearchApiResponse;
  state: S7SearchUiState;
  labels: S7SearchWorkbenchLabels;
  onSubmit: () => void;
  onModeChange: (mode: S7SearchMode) => void;
  onRetry: () => void;
  onValueChange?: (value: S7SearchFormValue) => void;
  onFiltersChange?: (filter: SearchFilterApi) => void;
}

function ResultMeta(props: { result: SearchApiResponse; labels: S7SearchWorkbenchLabels }) {
  return (
    <Flex gap={2} wrap="wrap" align="center">
      <Badge variant="outline" borderColor="kn.line" color="kn.ink" bg="kn.surface">
        {props.result.mode}
      </Badge>
      <Badge variant="outline" borderColor="kn.line" color="kn.ink" bg="kn.surface">
        {props.labels.resultCount} {props.result.items.length}
      </Badge>
      <Badge variant="outline" borderColor="kn.line" color="kn.ink" bg="kn.surface">
        {props.labels.duration} {props.result.durationMs} ms
      </Badge>
      <Badge variant="outline" borderColor="kn.line" color="kn.ink" bg="kn.surface">
        {props.labels.rerankApplied} {props.result.rerankApplied ? 'true' : 'false'}
      </Badge>
    </Flex>
  );
}

function DegradedCodes(props: { codes: readonly string[]; labels: S7SearchWorkbenchLabels }) {
  const safe = props.codes
    .map((code) => safeDegradedCode(code))
    .filter((code): code is string => code !== null);
  if (safe.length === 0) return null;
  return (
    <Flex mt={2} gap={2} wrap="wrap">
      {safe.map((code) => (
        <Badge key={code} variant="outline" color="kn.ink" borderColor="kn.warning" bg="kn.surface">
          {code}
        </Badge>
      ))}
    </Flex>
  );
}

export function S7SearchWorkbench(props: S7SearchWorkbenchProps) {
  const result = props.result ?? ('result' in props.state ? props.state.result : undefined);
  const [draft, setDraft] = useState(props.value);
  const [draftFilters, setDraftFilters] = useState(props.filters);
  useEffect(() => {
    setDraft(props.value);
  }, [props.value]);
  useEffect(() => {
    setDraftFilters(props.filters);
  }, [props.filters]);
  return (
    <Box as="main" id="knowledge-main" minW={0}>
      <Box as="header" mb={5}>
        <Heading as="h1" m={0} fontSize={{ base: '24px', md: '30px' }} letterSpacing={0}>
          {props.labels.title}
        </Heading>
        <Text mt={2} mb={0} color="kn.inkMuted">
          {props.labels.description}
        </Text>
      </Box>

      <S7SearchFilters
        value={draft}
        filters={draftFilters}
        tags={props.tags}
        spaces={props.spaces}
        labels={props.labels}
        busy={props.state.kind === 'loading'}
        onValueChange={(value) => {
          setDraft(value);
          if (value.mode !== props.mode) props.onModeChange(value.mode);
          props.onValueChange?.(value);
        }}
        onFiltersChange={(filter) => {
          setDraftFilters(filter);
          props.onFiltersChange?.(filter);
        }}
        onSubmit={props.onSubmit}
      />

      <Box as="section" mt={8} minW={0}>
        <Flex justify="space-between" align="center" gap={3} mb={3}>
          <Heading as="h2" m={0} fontSize="lg" letterSpacing={0}>
            {props.labels.results}
          </Heading>
          {result ? <ResultMeta result={result} labels={props.labels} /> : null}
        </Flex>

        {props.state.kind === 'idle' ? <Text color="kn.inkMuted">{props.labels.idle}</Text> : null}
        {props.state.kind === 'loading' ? (
          <Stack spacing={3} aria-label={props.labels.loading}>
            <Skeleton height="48px" />
            <Skeleton height="120px" />
            <Skeleton height="120px" />
          </Stack>
        ) : null}
        {props.state.kind === 'empty' ? (
          <Alert status="info" variant="left-accent">
            <AlertIcon />
            <AlertDescription>{props.labels.empty}</AlertDescription>
          </Alert>
        ) : null}
        {props.state.kind === 'partial' ? (
          <Alert status="warning" variant="left-accent" mb={4}>
            <AlertIcon />
            <Box>
              <AlertTitle>{props.labels.partial}</AlertTitle>
              <DegradedCodes codes={props.state.result.degraded ?? []} labels={props.labels} />
            </Box>
          </Alert>
        ) : null}
        {props.state.kind === 'degraded' ? (
          <Alert status="warning" variant="left-accent" mb={4}>
            <AlertIcon />
            <Box>
              <AlertTitle>{props.labels.degraded}</AlertTitle>
              <DegradedCodes codes={props.state.result.degraded ?? []} labels={props.labels} />
            </Box>
          </Alert>
        ) : null}
        {props.state.kind === 'permission' ||
        props.state.kind === 'timeout' ||
        props.state.kind === 'rate_limited' ||
        props.state.kind === 'error' ? (
          <Alert status={props.state.kind === 'permission' ? 'warning' : 'error'}>
            <AlertIcon />
            <Box flex="1">
              <AlertTitle>
                {props.state.kind === 'permission'
                  ? props.labels.permission
                  : props.state.kind === 'timeout'
                    ? props.labels.timeout
                    : props.state.kind === 'rate_limited'
                      ? props.labels.rateLimited
                      : props.labels.error}
              </AlertTitle>
              <AlertDescription>
                <Text>
                  {props.labels.code}: {props.state.code}
                </Text>
                {props.state.traceId ? (
                  <Text overflowWrap="anywhere">
                    {props.labels.trace}: {props.state.traceId}
                  </Text>
                ) : null}
              </AlertDescription>
            </Box>
          </Alert>
        ) : null}

        {(props.state.kind === 'permission' ||
          props.state.kind === 'timeout' ||
          props.state.kind === 'rate_limited' ||
          props.state.kind === 'error') &&
        'retryable' in props.state &&
        props.state.retryable ? (
          <Button
            mt={3}
            size="sm"
            variant="outline"
            leftIcon={<RepeatIcon />}
            onClick={props.onRetry}
            borderRadius="sm"
          >
            {props.labels.retry}
          </Button>
        ) : null}

        {result ? (
          <Stack spacing={5} mt={4}>
            {result.items.map((item, index) => (
              <Box
                key={item.citation.citationId}
                borderTopWidth={index === 0 ? '0' : '1px'}
                borderColor="kn.line"
                pt={index === 0 ? 0 : 5}
                minW={0}
              >
                <S7CitationView
                  citation={item.citation}
                  content={item.segment.content}
                  labels={props.labels.citation}
                />
              </Box>
            ))}
          </Stack>
        ) : null}
      </Box>
    </Box>
  );
}
