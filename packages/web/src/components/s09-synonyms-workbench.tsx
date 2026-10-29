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
  Input,
  Progress,
  Skeleton,
  Stack,
  Table,
  TableContainer,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tr,
  VisuallyHidden,
} from '@chakra-ui/react';
import { AttachmentIcon, DownloadIcon, RepeatIcon, SearchIcon, TimeIcon } from '@chakra-ui/icons';
import { useEffect, useMemo, useState } from 'react';
import type { S09SynonymConfigData, S09SynonymMappingData } from '../client/s09-synonym-client';
import { validateSynonymFileDraft, type S09SynonymUiState } from './s09-synonym-state';

export interface S09SynonymsWorkbenchLabels {
  title: string;
  description: string;
  file: string;
  chooseFile: string;
  upload: string;
  update: string;
  replace: string;
  enable: string;
  disable: string;
  rebuild: string;
  delete: string;
  confirmDelete: string;
  cancel: string;
  download: string;
  mappings: string;
  terms: string;
  searchMappings: string;
  search: string;
  loadMore: string;
  standard: string;
  synonyms: string;
  fingerprint: string;
  version: string;
  status: string;
  active: string;
  disabled: string;
  rebuilding: string;
  failed: string;
  empty: string;
  loading: string;
  noMappings: string;
  invalidFile: string;
  conflict: string;
  rateLimited: string;
  permission: string;
  payloadTooLarge: string;
  error: string;
  retry: string;
  trace: string;
  code: string;
  row: string;
  column: string;
  progress: string;
  fileTooLarge: string;
  fileExtension: string;
  fileRequired: string;
  fileEmpty: string;
}

export const DEFAULT_S09_SYNONYM_LABELS: S09SynonymsWorkbenchLabels = {
  title: '同义词',
  description: '',
  file: '同义词文件',
  chooseFile: '选择 CSV、XLS 或 XLSX',
  upload: '上传',
  update: '更新版本',
  replace: '替换文件',
  enable: '启用',
  disable: '停用',
  rebuild: '重建索引',
  delete: '删除',
  confirmDelete: '确认停用并删除当前发布版本？',
  cancel: '取消',
  download: '下载 CSV',
  mappings: '映射',
  terms: '词条',
  searchMappings: '搜索标准词或同义词',
  search: '搜索',
  loadMore: '下一页',
  standard: '标准词',
  synonyms: '同义词',
  fingerprint: '指纹',
  version: '版本',
  status: '状态',
  active: '已启用',
  disabled: '已停用',
  rebuilding: '重建中',
  failed: '失败',
  empty: '尚未上传同义词文件。',
  loading: '正在加载',
  noMappings: '没有匹配的映射。',
  invalidFile: '文件校验失败',
  conflict: '版本已变化，请刷新后重试。',
  rateLimited: '请求过于频繁，请稍后重试。',
  permission: '当前操作不可用。',
  payloadTooLarge: '文件超过 10 MiB。',
  error: '操作失败。',
  retry: '重试',
  trace: 'Trace',
  code: 'Code',
  row: '行',
  column: '列',
  progress: '重建进度',
  fileTooLarge: '文件不能超过 10 MiB。',
  fileExtension: '仅支持 CSV、XLS 和 XLSX。',
  fileRequired: '请选择文件。',
  fileEmpty: '文件不能为空。',
};

export interface S09SynonymsWorkbenchProps {
  state: S09SynonymUiState;
  canManage: boolean;
  labels?: Partial<S09SynonymsWorkbenchLabels>;
  busy?: boolean;
  onUpload?: (file: File, enabled: boolean) => void;
  onUpdate?: (file: File, enabled: boolean, expectedFileVersion: number) => void;
  onToggle?: (enabled: boolean) => void;
  onDelete?: () => void;
  onDownload?: (fileVersion: number) => void;
  onRebuild?: () => void;
  onMappingSearch?: (search: string) => void;
  onMappingPage?: (cursor?: string) => void;
  onRetry?: () => void;
}

function statusLabel(config: S09SynonymConfigData, labels: S09SynonymsWorkbenchLabels): string {
  if (config.status === 'disabled' || !config.enabled) return labels.disabled;
  if (config.status === 'rebuilding') return labels.rebuilding;
  if (config.status === 'failed') return labels.failed;
  return labels.active;
}

function configOf(state: S09SynonymUiState): S09SynonymConfigData | undefined {
  return 'config' in state ? state.config : undefined;
}

function mappingsOf(state: S09SynonymUiState): S09SynonymMappingData[] {
  return state.kind === 'ready' ? state.mappings : [];
}

function Diagnostics(props: {
  state: Extract<S09SynonymUiState, { kind: 'invalid_file' }>;
  labels: S09SynonymsWorkbenchLabels;
}) {
  return (
    <Alert status="error" variant="left-accent">
      <AlertIcon />
      <Box minW={0}>
        <AlertTitle>{props.labels.invalidFile}</AlertTitle>
        <AlertDescription>
          <Text>
            {props.labels.code}: {props.state.code}
          </Text>
          {props.state.traceId ? (
            <Text overflowWrap="anywhere">
              {props.labels.trace}: {props.state.traceId}
            </Text>
          ) : null}
          <Stack as="ul" mt={2} spacing={1} pl={5}>
            {props.state.diagnostics.map((diagnostic, index) => (
              <Text as="li" key={`${diagnostic.rowNumber}-${diagnostic.columnNumber}-${index}`}>
                {props.labels.row} {diagnostic.rowNumber ?? '-'} · {props.labels.column}{' '}
                {diagnostic.columnNumber ?? '-'} · {diagnostic.messageKey}
              </Text>
            ))}
          </Stack>
          {props.state.truncated ? (
            <Text mt={2}>
              {props.state.diagnostics.length} / {props.state.totalDiagnostics}
            </Text>
          ) : null}
        </AlertDescription>
      </Box>
    </Alert>
  );
}

export function S09SynonymsWorkbench(props: S09SynonymsWorkbenchProps) {
  const labels = { ...DEFAULT_S09_SYNONYM_LABELS, ...props.labels };
  const config = configOf(props.state);
  const mappings = mappingsOf(props.state);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [enabledDraft, setEnabledDraft] = useState(config?.enabled ?? true);
  useEffect(() => {
    setEnabledDraft(config?.enabled ?? true);
  }, [config?.enabled, config?.version]);
  const disabled = props.busy || props.state.kind === 'loading';
  const status = useMemo(() => (config ? statusLabel(config, labels) : null), [config, labels]);

  const chooseFile = (candidate: File | null) => {
    setFile(candidate);
    const validation = validateSynonymFileDraft(
      candidate ? { name: candidate.name, sizeBytes: candidate.size } : null,
    );
    if (validation.valid) {
      setFileError(null);
      return;
    }
    setFileError(
      validation.reason === 'size'
        ? labels.fileTooLarge
        : validation.reason === 'extension'
          ? labels.fileExtension
          : validation.reason === 'empty'
            ? labels.fileEmpty
            : labels.fileRequired,
    );
  };

  const submit = () => {
    if (!file) {
      setFileError(labels.fileRequired);
      return;
    }
    if (config && props.onUpdate) {
      props.onUpdate(file, enabledDraft, config.activeFileVersion);
    } else if (props.onUpload) {
      props.onUpload(file, enabledDraft);
    }
  };

  return (
    <Box as="main" id="knowledge-main" minW={0}>
      <Box as="header" mb={6}>
        <Heading as="h1" m={0} fontSize={{ base: '24px', md: '30px' }} letterSpacing={0}>
          {labels.title}
        </Heading>
        {labels.description ? (
          <Text mt={2} mb={0} color="kn.inkMuted">
            {labels.description}
          </Text>
        ) : null}
      </Box>

      <Box as="section" borderTopWidth="1px" borderColor="kn.line" pt={5}>
        <Flex justify="space-between" align="flex-start" gap={4} wrap="wrap">
          <Stack spacing={1} minW={0}>
            <Text fontWeight="semibold" color="kn.ink">
              {config?.fileName ?? labels.empty}
            </Text>
            {config ? (
              <Flex gap={2} wrap="wrap">
                <Badge variant="outline" borderColor="kn.line" color="kn.ink">
                  {labels.version} {config.activeFileVersion}
                </Badge>
                <Badge
                  variant="outline"
                  color="kn.ink"
                  borderColor={
                    config.status === 'failed'
                      ? 'kn.danger'
                      : config.status === 'rebuilding'
                        ? 'kn.warning'
                        : 'kn.line'
                  }
                >
                  {status}
                </Badge>
                <Text fontSize="sm" color="kn.inkMuted">
                  {config.mappingCount} {labels.mappings} · {config.termCount} {labels.terms}
                </Text>
              </Flex>
            ) : null}
          </Stack>
          <Flex gap={2} wrap="wrap">
            {config ? (
              <Button
                size="sm"
                variant="outline"
                leftIcon={<DownloadIcon />}
                isDisabled={disabled}
                onClick={() => props.onDownload?.(config.activeFileVersion)}
              >
                {labels.download}
              </Button>
            ) : null}
            {config && props.canManage ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  isDisabled={disabled || config.status === 'rebuilding'}
                  onClick={() => props.onToggle?.(!config.enabled)}
                >
                  {config.enabled ? labels.disable : labels.enable}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  leftIcon={<RepeatIcon />}
                  isDisabled={disabled || config.status === 'rebuilding' || !config.enabled}
                  onClick={props.onRebuild}
                >
                  {labels.rebuild}
                </Button>
              </>
            ) : null}
          </Flex>
        </Flex>

        {props.state.kind === 'loading' ? (
          <Stack mt={5} spacing={3} role="status" aria-label={labels.loading}>
            <Skeleton height="36px" />
            <Skeleton height="96px" />
          </Stack>
        ) : null}
        {props.state.kind === 'empty' ? (
          <Alert mt={5} status="info" variant="left-accent">
            <AlertIcon />
            <AlertDescription>{labels.empty}</AlertDescription>
          </Alert>
        ) : null}
        {props.state.kind === 'invalid_file' ? (
          <Box mt={5}>
            <Diagnostics state={props.state} labels={labels} />
          </Box>
        ) : null}
        {props.state.kind === 'rebuilding' ? (
          <Box mt={5}>
            <Flex justify="space-between" gap={3} mb={2}>
              <Text fontWeight="semibold">{labels.progress}</Text>
              <Text color="kn.inkMuted">{props.state.job?.status ?? labels.rebuilding}</Text>
            </Flex>
            <Progress
              aria-label={labels.progress}
              value={Number(props.state.job?.progress?.percent ?? 0)}
              size="sm"
              colorScheme="teal"
              bg="kn.surfaceMuted"
            />
          </Box>
        ) : null}
        {props.state.kind === 'failed' ? (
          <Alert mt={5} status="warning" variant="left-accent">
            <AlertIcon />
            <Box>
              <AlertTitle>{labels.failed}</AlertTitle>
              <AlertDescription>
                {props.state.code}
                {props.state.traceId ? ` · ${labels.trace}: ${props.state.traceId}` : ''}
              </AlertDescription>
            </Box>
          </Alert>
        ) : null}
        {props.state.kind === 'conflict' ||
        props.state.kind === 'rate_limited' ||
        props.state.kind === 'error' ||
        props.state.kind === 'permission' ||
        props.state.kind === 'payload_too_large' ? (
          <Alert
            mt={5}
            status={
              props.state.kind === 'permission' || props.state.kind === 'conflict'
                ? 'warning'
                : 'error'
            }
            variant="left-accent"
          >
            <AlertIcon />
            <Box flex="1" minW={0}>
              <AlertTitle>
                {props.state.kind === 'conflict'
                  ? labels.conflict
                  : props.state.kind === 'rate_limited'
                    ? labels.rateLimited
                    : props.state.kind === 'permission'
                      ? labels.permission
                      : props.state.kind === 'payload_too_large'
                        ? labels.payloadTooLarge
                        : labels.error}
              </AlertTitle>
              <AlertDescription>
                <Text overflowWrap="anywhere">
                  {props.state.messageKey} · {props.state.code}
                </Text>
                {props.state.traceId ? (
                  <Text overflowWrap="anywhere">
                    {labels.trace}: {props.state.traceId}
                  </Text>
                ) : null}
              </AlertDescription>
            </Box>
            {props.state.retryable && props.onRetry ? (
              <Button size="sm" variant="outline" onClick={props.onRetry}>
                {labels.retry}
              </Button>
            ) : null}
          </Alert>
        ) : null}

        {props.canManage ? (
          <Box mt={6} borderTopWidth="1px" borderColor="kn.line" pt={5} minW={0}>
            <Flex gap={3} align="flex-end" wrap="wrap">
              <Box flex="1 1 280px" minW={0}>
                <Text as="label" htmlFor="s09-synonym-file" fontWeight="semibold">
                  {labels.file}
                </Text>
                <Input
                  id="s09-synonym-file"
                  mt={2}
                  type="file"
                  accept=".csv,.xls,.xlsx"
                  p={1}
                  aria-label={labels.chooseFile}
                  isDisabled={disabled}
                  onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
                />
                {fileError ? (
                  <Text mt={1} color="kn.danger" fontSize="sm">
                    {fileError}
                  </Text>
                ) : null}
              </Box>
              <Button
                size="sm"
                variant="outline"
                isDisabled={disabled || !file || Boolean(fileError)}
                onClick={() => setEnabledDraft((current) => !current)}
              >
                {enabledDraft ? labels.disable : labels.enable}
              </Button>
              <Button
                size="sm"
                leftIcon={<AttachmentIcon />}
                colorScheme="teal"
                isDisabled={disabled || !file || Boolean(fileError)}
                onClick={submit}
              >
                {config ? labels.update : labels.upload}
              </Button>
              {config ? (
                <Button
                  size="sm"
                  variant="ghost"
                  isDisabled={disabled}
                  onClick={() => setConfirmDelete(true)}
                >
                  {labels.delete}
                </Button>
              ) : null}
            </Flex>
            {confirmDelete ? (
              <Alert mt={4} status="warning">
                <AlertIcon />
                <AlertDescription flex="1">{labels.confirmDelete}</AlertDescription>
                <Flex gap={2}>
                  <Button size="sm" variant="outline" onClick={() => setConfirmDelete(false)}>
                    {labels.cancel}
                  </Button>
                  <Button
                    size="sm"
                    colorScheme="red"
                    onClick={() => {
                      setConfirmDelete(false);
                      props.onDelete?.();
                    }}
                  >
                    {labels.delete}
                  </Button>
                </Flex>
              </Alert>
            ) : null}
          </Box>
        ) : null}
      </Box>

      <Box as="section" mt={8} minW={0}>
        <Flex justify="space-between" align="center" gap={3} mb={3} wrap="wrap">
          <Heading as="h2" m={0} fontSize="lg" letterSpacing={0}>
            {labels.mappings}
          </Heading>
          <Flex
            as="form"
            gap={2}
            wrap="wrap"
            onSubmit={(event) => {
              event.preventDefault();
              props.onMappingSearch?.(search);
            }}
          >
            <Input
              aria-label={labels.searchMappings}
              size="sm"
              width={{ base: 'full', md: '280px' }}
              value={search}
              placeholder={labels.searchMappings}
              onChange={(event) => setSearch(event.target.value)}
            />
            <Button
              type="submit"
              size="sm"
              variant="outline"
              leftIcon={<SearchIcon />}
              isDisabled={disabled}
            >
              {labels.search}
            </Button>
          </Flex>
        </Flex>
        <TableContainer
          borderWidth="1px"
          borderColor="kn.line"
          overflowX="auto"
          tabIndex={0}
          aria-label={labels.mappings}
        >
          <Table size="sm" variant="simple">
            <VisuallyHidden as="caption">{labels.mappings}</VisuallyHidden>
            <Thead>
              <Tr>
                <Th scope="col">{labels.standard}</Th>
                <Th scope="col">{labels.synonyms}</Th>
                <Th scope="col">{labels.version}</Th>
                <Th scope="col">{labels.fingerprint}</Th>
              </Tr>
            </Thead>
            <Tbody>
              {mappings.map((mapping) => (
                <Tr key={`${mapping.fileVersion}:${mapping.logicalMappingId}`}>
                  <Td fontWeight="medium">{mapping.standardizedTerm}</Td>
                  <Td>
                    <Flex gap={1} wrap="wrap">
                      {mapping.synonymTerms.map((term) => (
                        <Badge key={term} variant="outline" borderColor="kn.line" color="kn.ink">
                          {term}
                        </Badge>
                      ))}
                    </Flex>
                  </Td>
                  <Td>{mapping.fileVersion}</Td>
                  <Td fontFamily="mono" fontSize="xs">
                    {mapping.fingerprint.slice(0, 12)}
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </TableContainer>
        {mappings.length === 0 && props.state.kind !== 'loading' ? (
          <Text mt={3} color="kn.inkMuted">
            {labels.noMappings}
          </Text>
        ) : null}
        {props.state.kind === 'ready' && props.state.hasMore ? (
          <Button
            mt={3}
            size="sm"
            variant="outline"
            leftIcon={<TimeIcon />}
            isDisabled={disabled}
            onClick={() =>
              props.onMappingPage?.(
                props.state.kind === 'ready' ? (props.state.nextCursor ?? undefined) : undefined,
              )
            }
          >
            {labels.loadMore}
          </Button>
        ) : null}
      </Box>
    </Box>
  );
}
