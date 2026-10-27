'use client';

import { Box, Flex, Heading, Stack, Text } from '@chakra-ui/react';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Button, Field, StatusTag, TextArea, TextInput } from './knowledge-primitives';
import { useKnowledgeI18n } from '../i18n';

export interface S6SegmentIndexView {
  indexId: string;
  type: 'default' | 'custom' | 'question' | 'summary';
  modelId: string;
  dimension: 768 | 1024 | 1536 | 3072;
  storageType: 'vector' | 'halfvec';
  vectorProfile: string;
  vectorId: string;
  text: string;
  version: number;
}

export interface S6SegmentHistoryView {
  version: number;
  question: string;
  answer: string;
  changedAt: string;
  changedByMemberId: string;
}

export interface S6SegmentView {
  id: string;
  question: string;
  answer: string;
  searchEnabled: boolean;
  indexStatus: string;
  indexErrorCode: string | null;
  indexes: S6SegmentIndexView[];
  version: number;
}

export function S6SegmentIndexEditor(props: {
  segment: S6SegmentView;
  history: S6SegmentHistoryView[];
  busy?: boolean;
  onSave: (input: {
    question: string;
    answer: string;
    searchEnabled: boolean;
    version: number;
  }) => Promise<void>;
  onIndexUpsert: (input: {
    indexId: string;
    type: 'default' | 'custom' | 'question' | 'summary';
    text: string;
    modelId: string;
    version: number;
  }) => Promise<void>;
  onIndexDelete: (indexId: string) => Promise<void>;
  onReindex: (reason: 'manual' | 'model_change' | 'synonym_change' | 'repair') => Promise<void>;
}) {
  const { t } = useKnowledgeI18n();
  const [question, setQuestion] = useState(props.segment.question);
  const [answer, setAnswer] = useState(props.segment.answer);
  const [searchEnabled, setSearchEnabled] = useState(props.segment.searchEnabled);
  const [indexId, setIndexId] = useState('default');
  const [indexType, setIndexType] = useState<S6SegmentIndexView['type']>('default');
  const [indexText, setIndexText] = useState(props.segment.question);
  const [modelId, setModelId] = useState(props.segment.indexes[0]?.modelId ?? '');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (dirty) return;
    setQuestion(props.segment.question);
    setAnswer(props.segment.answer);
    setSearchEnabled(props.segment.searchEnabled);
    setIndexText(props.segment.question);
    setModelId(props.segment.indexes[0]?.modelId ?? '');
  }, [dirty, props.segment]);

  return (
    <Stack spacing={7}>
      <Box
        as="form"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          void props
            .onSave({ question, answer, searchEnabled, version: props.segment.version })
            .then(() => setDirty(false));
        }}
      >
        <Flex justify="space-between" gap={3} align="center" wrap="wrap" mb={4}>
          <Heading as="h2" m={0} fontSize="lg">
            {t('s6.segment.fieldsTitle')}
          </Heading>
          <StatusTag value={props.segment.indexStatus} />
        </Flex>
        <Stack spacing={4}>
          <Field label={t('segments.question')}>
            <TextInput
              value={question}
              onChange={(event) => {
                setDirty(true);
                setQuestion(event.target.value);
              }}
            />
          </Field>
          <Field label={t('segments.answer')}>
            <TextArea
              value={answer}
              onChange={(event) => {
                setDirty(true);
                setAnswer(event.target.value);
              }}
            />
          </Field>
          <label>
            <input
              type="checkbox"
              checked={searchEnabled}
              onChange={(event) => {
                setDirty(true);
                setSearchEnabled(event.target.checked);
              }}
            />{' '}
            {t('s6.segment.searchEnabled')}
          </label>
          {props.segment.indexErrorCode ? (
            <Text role="alert" color="kn.danger" m={0}>
              {props.segment.indexErrorCode}
            </Text>
          ) : null}
          <Flex gap={2} wrap="wrap">
            <Button type="submit" tone="primary" busy={props.busy}>
              {t('common.save')}
            </Button>
            <Button type="button" busy={props.busy} onClick={() => void props.onReindex('manual')}>
              {t('s6.segment.reindex')}
            </Button>
          </Flex>
        </Stack>
      </Box>

      <Box borderTopWidth="1px" borderColor="kn.line" pt={5}>
        <Heading as="h2" m={0} mb={4} fontSize="lg">
          {t('s6.segment.indexesTitle')}
        </Heading>
        <Stack spacing={3}>
          {props.segment.indexes.map((index) => (
            <Box key={index.indexId} borderWidth="1px" borderColor="kn.line" p={3}>
              <Flex justify="space-between" gap={3} wrap="wrap">
                <Box minW={0}>
                  <Text m={0} fontWeight="700">
                    {index.indexId} · {index.type}
                  </Text>
                  <Text m={0} fontSize="xs" color="kn.inkMuted" overflowWrap="anywhere">
                    {index.modelId} · {index.dimension} · {index.storageType} · {index.vectorId}
                  </Text>
                </Box>
                <Button
                  size="sm"
                  tone="danger"
                  busy={props.busy}
                  onClick={() => void props.onIndexDelete(index.indexId)}
                >
                  {t('s6.segment.deleteIndex')}
                </Button>
              </Flex>
            </Box>
          ))}
        </Stack>
        <Stack spacing={3} mt={4}>
          <Field label={t('s6.segment.indexId')}>
            <TextInput value={indexId} onChange={(event) => setIndexId(event.target.value)} />
          </Field>
          <Field label={t('s6.segment.indexType')}>
            <select
              className="text-input"
              aria-label={t('s6.segment.indexType')}
              value={indexType}
              onChange={(event) => setIndexType(event.target.value as S6SegmentIndexView['type'])}
            >
              <option value="default">default</option>
              <option value="custom">custom</option>
              <option value="question">question</option>
              <option value="summary">summary</option>
            </select>
          </Field>
          <Field label={t('s6.segment.modelId')}>
            <TextInput value={modelId} onChange={(event) => setModelId(event.target.value)} />
          </Field>
          <Field label={t('s6.segment.indexText')}>
            <TextArea value={indexText} onChange={(event) => setIndexText(event.target.value)} />
          </Field>
          <Button
            busy={props.busy}
            disabled={!indexId || !modelId || !indexText.trim()}
            onClick={() =>
              void props.onIndexUpsert({
                indexId,
                type: indexType,
                text: indexText,
                modelId,
                version: props.segment.version,
              })
            }
          >
            {t('s6.segment.saveIndex')}
          </Button>
        </Stack>
      </Box>

      <Box borderTopWidth="1px" borderColor="kn.line" pt={5}>
        <Heading as="h2" m={0} mb={3} fontSize="lg">
          {t('s6.segment.historyTitle')}
        </Heading>
        <Stack spacing={2}>
          {props.history.length === 0 ? (
            <Text m={0} color="kn.inkMuted">
              {t('s6.segment.noHistory')}
            </Text>
          ) : (
            props.history.map((entry) => (
              <Box key={`${entry.version}-${entry.changedAt}`} fontSize="sm">
                <Text m={0}>
                  v{entry.version} · {entry.changedByMemberId} · {entry.changedAt}
                </Text>
                <Text m={0} color="kn.inkMuted" noOfLines={2}>
                  {entry.question}
                </Text>
              </Box>
            ))
          )}
        </Stack>
      </Box>
    </Stack>
  );
}
