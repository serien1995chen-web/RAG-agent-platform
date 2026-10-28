'use client';

import {
  Alert,
  AlertDescription,
  AlertIcon,
  Box,
  Checkbox,
  Grid,
  Heading,
  Input,
  Text,
} from '@chakra-ui/react';
import type { DeepSearchApiResponse } from '@kb/contracts';
import type { S8SearchFormValues } from '../forms/s8-search-form';
import { Button, Field, ProblemNotice } from './knowledge-primitives';
import { S7CitationView, type S7CitationViewLabels } from './s7-citation-view';

export interface S8DeepSearchPanelLabels {
  title: string;
  description: string;
  query: string;
  queryPlaceholder: string;
  maxRounds: string;
  roundTokenBudget: string;
  tokenBudget: string;
  stopWhenNoNewEvidence: string;
  run: string;
  running: string;
  idle: string;
  partial: string;
  rounds: string;
  round: string;
  candidateCount: string;
  sufficient: string;
  stopReason: string;
  usage: string;
  error: string;
  retry: string;
  citation: S7CitationViewLabels;
}

export interface S8DeepSearchPanelProps {
  value: S8SearchFormValues;
  labels: S8DeepSearchPanelLabels;
  result?: DeepSearchApiResponse;
  error?: unknown;
  state: 'idle' | 'loading' | 'ready' | 'error';
  onChange: (next: Partial<S8SearchFormValues>) => void;
  onSubmit: () => void;
  onRetry: () => void;
}

export function S8DeepSearchPanel(props: S8DeepSearchPanelProps) {
  return (
    <Box as="main" id="knowledge-main" minW={0}>
      <Heading as="h1" m={0} fontSize={{ base: '24px', md: '30px' }} letterSpacing={0}>
        {props.labels.title}
      </Heading>
      <Text mt={2} color="kn.inkMuted">
        {props.labels.description}
      </Text>

      <Box mt={6}>
        <Field label={props.labels.query}>
          <Input
            value={props.value.query}
            placeholder={props.labels.queryPlaceholder}
            onChange={(event) => props.onChange({ query: event.target.value })}
          />
        </Field>
        <Grid
          mt={4}
          templateColumns={{ base: 'minmax(0, 1fr)', md: 'repeat(3, minmax(0, 1fr))' }}
          gap={4}
        >
          <Field label={props.labels.maxRounds}>
            <Input
              type="number"
              min={1}
              max={3}
              value={props.value.maxRounds}
              onChange={(event) => props.onChange({ maxRounds: Number(event.target.value) })}
            />
          </Field>
          <Field label={props.labels.roundTokenBudget}>
            <Input
              type="number"
              min={500}
              max={20_000}
              value={props.value.roundTokenBudget}
              onChange={(event) => props.onChange({ roundTokenBudget: Number(event.target.value) })}
            />
          </Field>
          <Field label={props.labels.tokenBudget}>
            <Input
              type="number"
              min={1}
              max={20_000}
              value={props.value.tokenBudget}
              onChange={(event) => props.onChange({ tokenBudget: Number(event.target.value) })}
            />
          </Field>
        </Grid>
        <Checkbox
          mt={4}
          isChecked={props.value.stopWhenNoNewEvidence}
          onChange={(event) => props.onChange({ stopWhenNoNewEvidence: event.target.checked })}
        >
          {props.labels.stopWhenNoNewEvidence}
        </Checkbox>
        <Box mt={4}>
          <Button
            tone="primary"
            busy={props.state === 'loading'}
            isDisabled={props.value.query.trim().length === 0}
            onClick={props.onSubmit}
          >
            {props.state === 'loading' ? props.labels.running : props.labels.run}
          </Button>
        </Box>
      </Box>

      {props.state === 'idle' ? <Text mt={6}>{props.labels.idle}</Text> : null}
      {props.state === 'error' ? (
        <ProblemNotice
          error={props.error ?? new Error('deep_search_failed')}
          onRetry={props.onRetry}
        />
      ) : null}
      {props.state === 'ready' && props.result ? (
        <Box as="section" mt={7} minW={0}>
          {props.result.partial ? (
            <Alert status="warning" variant="left-accent">
              <AlertIcon />
              <AlertDescription>{props.labels.partial}</AlertDescription>
            </Alert>
          ) : null}
          <Grid
            mt={4}
            templateColumns={{ base: 'minmax(0, 1fr)', md: 'repeat(3, minmax(0, 1fr))' }}
            gap={3}
          >
            <Text m={0}>
              <Text as="strong">{props.labels.stopReason}:</Text> {props.result.stopReason}
            </Text>
            <Text m={0}>
              <Text as="strong">{props.labels.usage}:</Text> {props.result.usage.inputTokens} /{' '}
              {props.result.usage.outputTokens}
            </Text>
            <Text m={0}>
              <Text as="strong">{props.labels.rounds}:</Text> {props.result.rounds.length}
            </Text>
          </Grid>
          <Box as="ol" mt={5} pl={5} minW={0}>
            {props.result.rounds.map((round) => (
              <Box as="li" key={round.round} mt={3} overflowWrap="anywhere">
                <Text as="strong">
                  {props.labels.round} {round.round}
                </Text>
                <Text mt={1}>{round.queries.join(' · ')}</Text>
                <Text mt={1} color="kn.inkMuted" fontSize="sm">
                  {props.labels.candidateCount} {round.candidateCount} · {props.labels.sufficient}{' '}
                  {String(round.sufficient)}
                </Text>
              </Box>
            ))}
          </Box>
          <Box mt={6}>
            {props.result.items.map((item, index) => (
              <Box
                key={item.citation.citationId}
                mt={index === 0 ? 0 : 5}
                pt={index === 0 ? 0 : 5}
                borderTopWidth={index === 0 ? '0' : '1px'}
                borderColor="kn.line"
                minW={0}
              >
                <S7CitationView
                  citation={item.citation}
                  content={[item.segment.question, item.segment.answer, item.segment.content]
                    .filter((value) => value.length > 0)
                    .join('\n')}
                  labels={props.labels.citation}
                />
              </Box>
            ))}
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}
