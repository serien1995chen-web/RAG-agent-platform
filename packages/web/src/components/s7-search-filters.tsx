'use client';

import {
  Box,
  Button,
  ButtonGroup,
  Flex,
  FormControl,
  FormLabel,
  Grid,
  Input,
  Select,
  Switch,
  Text,
  Textarea,
} from '@chakra-ui/react';
import { AddIcon, DeleteIcon, SearchIcon } from '@chakra-ui/icons';
import type { SearchFilterApi, TagFilterCondition } from '@kb/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import {
  S7_TAG_OPERATORS,
  addTagCondition,
  tagConditionFromDraft,
  type S7SearchMode,
} from '../forms/s7-search-form';
import { similarityControlEnabled } from './s7-search-state';

export interface S7TagChoice {
  id: string;
  label: string;
  tagType: 'string' | 'number' | 'datetime' | 'array';
}

export interface S7SpaceChoice {
  id: string;
  name: string;
}

export interface S7SearchFormValue {
  query: string;
  mode: S7SearchMode;
  tokenBudget: number;
  similarity: number;
  embeddingWeight: number;
  rerankWeight: number;
  usingRerank: boolean;
  knowledgeSpaceIds: string[];
}

export interface S7SearchFiltersLabels {
  query: string;
  queryPlaceholder: string;
  mode: string;
  semantic: string;
  fulltext: string;
  hybrid: string;
  multiSpace: string;
  tokenBudget: string;
  similarity: string;
  embeddingWeight: string;
  rerankWeight: string;
  usingRerank: string;
  filters: string;
  logic: string;
  and: string;
  or: string;
  sourceIds: string;
  directoryIds: string;
  createdAtGte: string;
  createdAtLte: string;
  tags: string;
  addTag: string;
  removeTag: string;
  tag: string;
  operator: string;
  value: string;
  spaces: string;
  run: string;
  running: string;
  similarityDisabled: string;
}

function parseIds(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

function valueForInput(type: 'string' | 'number' | 'datetime' | 'array', value: unknown): string {
  if (value === undefined || value === null) return '';
  if (type === 'array') {
    return Array.isArray(value) ? value.join(',') : String(value);
  }
  if (type === 'datetime' && typeof value === 'number') {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 16) : '';
  }
  return String(value);
}

function updateFilter(filter: SearchFilterApi, change: Partial<SearchFilterApi>): SearchFilterApi {
  return {
    logic: filter.logic,
    conditions: filter.conditions,
    ...change,
  };
}

export function S7SearchFilters(props: {
  value: S7SearchFormValue;
  filters: SearchFilterApi;
  tags: readonly S7TagChoice[];
  spaces: readonly S7SpaceChoice[];
  labels: S7SearchFiltersLabels;
  busy?: boolean;
  rerankAvailable?: boolean;
  onValueChange: (value: S7SearchFormValue) => void;
  onFiltersChange: (filter: SearchFilterApi) => void;
  onSubmit: () => void;
}) {
  const [sourceIds, setSourceIds] = useState((props.filters.sourceIds ?? []).join(', '));
  const [directoryIds, setDirectoryIds] = useState((props.filters.directoryIds ?? []).join(', '));
  useEffect(() => {
    setSourceIds((props.filters.sourceIds ?? []).join(', '));
  }, [props.filters.sourceIds]);
  useEffect(() => {
    setDirectoryIds((props.filters.directoryIds ?? []).join(', '));
  }, [props.filters.directoryIds]);

  const setValue = <K extends keyof S7SearchFormValue>(key: K, value: S7SearchFormValue[K]) =>
    props.onValueChange({ ...props.value, [key]: value });

  const setCondition = (index: number, condition: TagFilterCondition) => {
    props.onFiltersChange({
      ...props.filters,
      conditions: props.filters.conditions.map((entry, current) =>
        current === index ? condition : entry,
      ),
    });
  };

  const modeOptions: Array<{ mode: S7SearchMode; label: string }> = [
    { mode: 'semantic', label: props.labels.semantic },
    { mode: 'fulltext', label: props.labels.fulltext },
    { mode: 'hybrid', label: props.labels.hybrid },
    { mode: 'multi_space', label: props.labels.multiSpace },
  ];
  const similarityEnabled = similarityControlEnabled(props.value.mode, props.value.usingRerank);

  return (
    <Box
      as="form"
      minW={0}
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        props.onSubmit();
      }}
    >
      <Grid
        templateColumns={{ base: '1fr', lg: 'minmax(0, 2fr) minmax(280px, 1fr)' }}
        gap={5}
        alignItems="start"
      >
        <Box minW={0}>
          <FormControl>
            <FormLabel htmlFor="s7-search-query" fontSize="sm" fontWeight="700">
              {props.labels.query}
            </FormLabel>
            <Textarea
              id="s7-search-query"
              value={props.value.query}
              minH="120px"
              maxLength={20_000}
              placeholder={props.labels.queryPlaceholder}
              onChange={(event) => setValue('query', event.target.value)}
              bg="kn.surface"
              borderRadius="sm"
            />
          </FormControl>

          <FormControl mt={4}>
            <FormLabel fontSize="sm" fontWeight="700">
              {props.labels.mode}
            </FormLabel>
            <ButtonGroup
              isAttached
              variant="outline"
              flexWrap="wrap"
              gap={1}
              aria-label={props.labels.mode}
            >
              {modeOptions.map((option) => (
                <Button
                  key={option.mode}
                  type="button"
                  size="sm"
                  borderRadius="sm"
                  aria-pressed={props.value.mode === option.mode}
                  bg={props.value.mode === option.mode ? 'kn.primary' : 'kn.surface'}
                  color={props.value.mode === option.mode ? 'white' : 'kn.ink'}
                  onClick={() => setValue('mode', option.mode)}
                >
                  {option.label}
                </Button>
              ))}
            </ButtonGroup>
          </FormControl>

          {props.value.mode === 'multi_space' ? (
            <FormControl mt={4}>
              <FormLabel htmlFor="s7-search-spaces" fontSize="sm" fontWeight="700">
                {props.labels.spaces}
              </FormLabel>
              <Select
                id="s7-search-spaces"
                multiple
                value={props.value.knowledgeSpaceIds}
                onChange={(event) =>
                  setValue(
                    'knowledgeSpaceIds',
                    [...event.target.selectedOptions].map((option) => option.value),
                  )
                }
                minH="96px"
                borderRadius="sm"
              >
                {props.spaces.map((space) => (
                  <option key={space.id} value={space.id}>
                    {space.name}
                  </option>
                ))}
              </Select>
            </FormControl>
          ) : null}
        </Box>

        <Grid templateColumns="1fr" gap={4} minW={0}>
          <FormControl>
            <FormLabel htmlFor="s7-token-budget" fontSize="xs" fontWeight="700">
              {props.labels.tokenBudget}
            </FormLabel>
            <Input
              id="s7-token-budget"
              type="number"
              min={1}
              max={20_000}
              value={props.value.tokenBudget}
              onChange={(event) => setValue('tokenBudget', Number(event.target.value))}
              borderRadius="sm"
            />
          </FormControl>
          <FormControl isDisabled={!similarityEnabled}>
            <FormLabel htmlFor="s7-similarity" fontSize="xs" fontWeight="700">
              {props.labels.similarity}{' '}
              {similarityEnabled ? props.value.similarity : props.labels.similarityDisabled}
            </FormLabel>
            <input
              id="s7-similarity"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={props.value.similarity}
              disabled={!similarityEnabled}
              onChange={(event) => setValue('similarity', Number(event.target.value))}
              style={{ width: '100%' }}
            />
          </FormControl>
          <FormControl>
            <FormLabel htmlFor="s7-embedding-weight" fontSize="xs" fontWeight="700">
              {props.labels.embeddingWeight} {props.value.embeddingWeight}
            </FormLabel>
            <input
              id="s7-embedding-weight"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={props.value.embeddingWeight}
              onChange={(event) => setValue('embeddingWeight', Number(event.target.value))}
              style={{ width: '100%' }}
            />
          </FormControl>
          <FormControl>
            <FormLabel htmlFor="s7-rerank-weight" fontSize="xs" fontWeight="700">
              {props.labels.rerankWeight} {props.value.rerankWeight}
            </FormLabel>
            <input
              id="s7-rerank-weight"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={props.value.rerankWeight}
              onChange={(event) => setValue('rerankWeight', Number(event.target.value))}
              style={{ width: '100%' }}
            />
          </FormControl>
          <FormControl display="flex" alignItems="center" gap={3}>
            <Switch
              id="s7-using-rerank"
              isChecked={props.value.usingRerank}
              isDisabled={props.rerankAvailable === false}
              onChange={(event) => setValue('usingRerank', event.target.checked)}
            />
            <FormLabel htmlFor="s7-using-rerank" m={0} fontSize="sm" fontWeight="700">
              {props.labels.usingRerank}
            </FormLabel>
          </FormControl>
        </Grid>
      </Grid>

      <Box mt={6} borderTopWidth="1px" borderColor="kn.line" pt={4}>
        <Text as="h3" m={0} mb={3} fontSize="md" fontWeight="700">
          {props.labels.filters}
        </Text>
        <Grid templateColumns={{ base: '1fr', md: 'repeat(2, minmax(0, 1fr))' }} gap={4}>
          <FormControl>
            <FormLabel htmlFor="s7-filter-logic" fontSize="xs" fontWeight="700">
              {props.labels.logic}
            </FormLabel>
            <Select
              id="s7-filter-logic"
              value={props.filters.logic}
              onChange={(event) =>
                props.onFiltersChange(
                  updateFilter(props.filters, {
                    logic: event.target.value === 'OR' ? 'OR' : 'AND',
                  }),
                )
              }
              borderRadius="sm"
            >
              <option value="AND">{props.labels.and}</option>
              <option value="OR">{props.labels.or}</option>
            </Select>
          </FormControl>
          <FormControl>
            <FormLabel htmlFor="s7-filter-source-ids" fontSize="xs" fontWeight="700">
              {props.labels.sourceIds}
            </FormLabel>
            <Input
              id="s7-filter-source-ids"
              value={sourceIds}
              onChange={(event) => {
                setSourceIds(event.target.value);
                props.onFiltersChange(
                  updateFilter(props.filters, {
                    ...(parseIds(event.target.value).length
                      ? { sourceIds: parseIds(event.target.value) }
                      : { sourceIds: undefined }),
                  }),
                );
              }}
              borderRadius="sm"
            />
          </FormControl>
          <FormControl>
            <FormLabel htmlFor="s7-filter-directory-ids" fontSize="xs" fontWeight="700">
              {props.labels.directoryIds}
            </FormLabel>
            <Input
              id="s7-filter-directory-ids"
              value={directoryIds}
              onChange={(event) => {
                setDirectoryIds(event.target.value);
                props.onFiltersChange(
                  updateFilter(props.filters, {
                    ...(parseIds(event.target.value).length
                      ? { directoryIds: parseIds(event.target.value) }
                      : { directoryIds: undefined }),
                  }),
                );
              }}
              borderRadius="sm"
            />
          </FormControl>
          <FormControl>
            <FormLabel htmlFor="s7-filter-created-gte" fontSize="xs" fontWeight="700">
              {props.labels.createdAtGte}
            </FormLabel>
            <Input
              id="s7-filter-created-gte"
              type="datetime-local"
              value={props.filters.createdAt?.gte?.slice(0, 16) ?? ''}
              onChange={(event) =>
                props.onFiltersChange(
                  updateFilter(props.filters, {
                    createdAt: {
                      ...props.filters.createdAt,
                      ...(event.target.value
                        ? { gte: new Date(event.target.value).toISOString() }
                        : {}),
                    },
                  }),
                )
              }
              borderRadius="sm"
            />
          </FormControl>
          <FormControl>
            <FormLabel htmlFor="s7-filter-created-lte" fontSize="xs" fontWeight="700">
              {props.labels.createdAtLte}
            </FormLabel>
            <Input
              id="s7-filter-created-lte"
              type="datetime-local"
              value={props.filters.createdAt?.lte?.slice(0, 16) ?? ''}
              onChange={(event) =>
                props.onFiltersChange(
                  updateFilter(props.filters, {
                    createdAt: {
                      ...props.filters.createdAt,
                      ...(event.target.value
                        ? { lte: new Date(event.target.value).toISOString() }
                        : {}),
                    },
                  }),
                )
              }
              borderRadius="sm"
            />
          </FormControl>
        </Grid>

        <Flex align="center" justify="space-between" gap={3} mt={4} mb={2}>
          <Text as="h4" m={0} fontSize="sm" fontWeight="700">
            {props.labels.tags}
          </Text>
          <Button
            type="button"
            size="xs"
            leftIcon={<AddIcon />}
            onClick={() => props.onFiltersChange(addTagCondition(props.filters))}
            isDisabled={props.tags.length === 0}
            borderRadius="sm"
          >
            {props.labels.addTag}
          </Button>
        </Flex>
        <Flex direction="column" gap={3}>
          {props.filters.conditions.map((condition, index) => {
            const tag = props.tags.find((entry) => entry.id === condition.tagId);
            const type = condition.tagType;
            return (
              <Grid
                key={`${condition.tagId}-${index}`}
                templateColumns={{
                  base: '1fr',
                  xl: 'minmax(180px, 1fr) minmax(140px, .7fr) minmax(160px, 1fr) auto',
                }}
                gap={2}
                alignItems="end"
              >
                <FormControl>
                  <FormLabel htmlFor={`s7-tag-${index}`} fontSize="xs">
                    {props.labels.tag}
                  </FormLabel>
                  <Select
                    id={`s7-tag-${index}`}
                    value={condition.tagId}
                    onChange={(event) => {
                      const nextTag = props.tags.find((entry) => entry.id === event.target.value);
                      if (!nextTag) return;
                      setCondition(
                        index,
                        tagConditionFromDraft({
                          tagId: nextTag.id,
                          tagType: nextTag.tagType,
                          operator: S7_TAG_OPERATORS[nextTag.tagType][0]!,
                          value: nextTag.tagType === 'number' ? 0 : '',
                        }),
                      );
                    }}
                    borderRadius="sm"
                  >
                    <option value="">-</option>
                    {props.tags.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.label}
                      </option>
                    ))}
                  </Select>
                </FormControl>
                <FormControl>
                  <FormLabel htmlFor={`s7-tag-operator-${index}`} fontSize="xs">
                    {props.labels.operator}
                  </FormLabel>
                  <Select
                    id={`s7-tag-operator-${index}`}
                    value={condition.operator}
                    onChange={(event) =>
                      setCondition(
                        index,
                        tagConditionFromDraft({
                          tagId: condition.tagId,
                          tagType: type,
                          operator: event.target.value,
                          value:
                            event.target.value === '$empty' || event.target.value === '$notEmpty'
                              ? undefined
                              : tag?.tagType === 'number'
                                ? 0
                                : '',
                        }),
                      )
                    }
                    borderRadius="sm"
                  >
                    {S7_TAG_OPERATORS[type].map((operator) => (
                      <option key={operator} value={operator}>
                        {operator}
                      </option>
                    ))}
                  </Select>
                </FormControl>
                <FormControl
                  isDisabled={condition.operator === '$empty' || condition.operator === '$notEmpty'}
                >
                  <FormLabel htmlFor={`s7-tag-value-${index}`} fontSize="xs">
                    {props.labels.value}
                  </FormLabel>
                  <Input
                    id={`s7-tag-value-${index}`}
                    type={
                      type === 'number' ? 'number' : type === 'datetime' ? 'datetime-local' : 'text'
                    }
                    value={valueForInput(type, condition.value)}
                    onChange={(event) =>
                      setCondition(
                        index,
                        tagConditionFromDraft({
                          tagId: condition.tagId,
                          tagType: type,
                          operator: condition.operator,
                          value: event.target.value,
                        }),
                      )
                    }
                    borderRadius="sm"
                  />
                </FormControl>
                <Button
                  type="button"
                  size="sm"
                  aria-label={props.labels.removeTag}
                  leftIcon={<DeleteIcon />}
                  onClick={() =>
                    props.onFiltersChange({
                      ...props.filters,
                      conditions: props.filters.conditions.filter(
                        (_, current) => current !== index,
                      ),
                    })
                  }
                  borderRadius="sm"
                >
                  {props.labels.removeTag}
                </Button>
              </Grid>
            );
          })}
        </Flex>
      </Box>

      <Flex mt={6} justify="flex-end">
        <Button
          type="submit"
          leftIcon={<SearchIcon />}
          isLoading={props.busy}
          loadingText={props.labels.running}
          bg="kn.primary"
          color="white"
          borderRadius="sm"
          isDisabled={!props.value.query.trim()}
        >
          {props.labels.run}
        </Button>
      </Flex>
    </Box>
  );
}
