export {
  ensureConsoleSession,
  knowledgeBinaryRequest,
  knowledgeRequest,
  KnowledgeRequestError,
} from './client/knowledge-client';
export {
  S7DownstreamKnowledgeClient,
  S7DownstreamKnowledgeError,
  S7DownstreamNetworkError,
} from './client/s7-downstream-knowledge-client';
export type {
  S7DownstreamKnowledgeClientOptions,
  S7DownstreamRequestOptions,
  S7DownstreamResult,
} from './client/s7-downstream-knowledge-client';
export {
  clearKnowledgeUpload,
  knowledgeBinaryUpload,
  knowledgeMultipartUpload,
  restoreKnowledgeUpload,
} from './client/file-upload';
export type {
  KnowledgeFileUploadState,
  ObjectBlobReference,
  UploadSession,
} from './client/file-upload';
export type { ConsoleSession } from './client/knowledge-client';
export {
  Button,
  EmptyState,
  Field,
  FormBand,
  LoadingState,
  PageHeader,
  ProblemNotice,
  Section,
  SelectInput,
  StatusTag,
  TextArea,
  TextInput,
} from './components/knowledge-primitives';
export { KnowledgeDataTable } from './components/data-table';
export { ArchiveAction } from './components/archive-action';
export {
  CatalogBatchResult,
  CatalogMoveControl,
  SpaceExportAction,
  SpaceReferencesPanel,
} from './components/catalog-governance';
export type { BatchResultView, MoveTargetOption } from './components/catalog-governance';
export {
  batchResultRole,
  catalogGovernanceState,
  exportStatusTone,
  hasBlockingReference,
  shouldResetMoveIdempotencyKey,
} from './components/catalog-governance-state';
export type { CatalogGovernanceState } from './components/catalog-governance-state';
export { FilePreviewPanel } from './components/file-preview';
export { FileUploadPanel } from './components/file-upload';
export { IMPORT_SOURCE_KINDS, ImportWorkbench, splitIds } from './components/import-workbench';
export type { ImportSourceKind, ImportWorkbenchProps } from './components/import-workbench';
export {
  CONNECTOR_CREDENTIAL_FIELDS,
  CONNECTOR_PROVIDERS,
  ConnectorForm,
  normalizeConnectorProvider,
} from './components/connector-form';
export type { ConnectorFormInput, ConnectorRecord } from './components/connector-form';
export { ConnectorsPanel } from './components/connectors-panel';
export type { ConnectorsPanelProps } from './components/connectors-panel';
export { S5ModelBindingPanel } from './components/s5-model-binding';
export type {
  S5ModelBindingPanelProps,
  S5ModelValidationView,
} from './components/s5-model-binding';
export { S5ParseSettingsPanel } from './components/s5-parse-settings';
export type { S5ParseSettingsPanelProps } from './components/s5-parse-settings';
export {
  canSaveBinding,
  groupModelsByType,
  mergeBindingDraft,
  providerVerificationLabel,
  safeConflictRetryState,
  selectedModelCapabilities,
  stateFromProblem as s5StateFromProblem,
  toS5ProblemView,
} from './components/s5-model-parse-state';
export type {
  ProviderVerificationLabel,
  S5ModelBindingView,
  S5ModelParseState,
  S5ModelType,
  S5ModelView,
  S5ProblemView,
} from './components/s5-model-parse-state';
export { S6JobsPanel, jobActionsFor } from './components/s6-jobs-panel';
export type { S6JobAction, S6JobView } from './components/s6-jobs-panel';
export { S6SegmentIndexEditor } from './components/s6-segment-index-editor';
export type {
  S6SegmentHistoryView,
  S6SegmentIndexView,
  S6SegmentView,
} from './components/s6-segment-index-editor';
export { S7CitationView } from './components/s7-citation-view';
export type { S7CitationViewLabels } from './components/s7-citation-view';
export {
  S7MarkdownRenderer,
  S7MermaidBlock,
  sanitizeMermaidSvg,
} from './components/s7-markdown-renderer';
export {
  S7SearchFilters,
  type S7SearchFiltersLabels,
  type S7SearchFormValue,
  type S7SpaceChoice,
  type S7TagChoice,
} from './components/s7-search-filters';
export {
  classifyS7SearchState,
  safeDegradedCode,
  similarityControlEnabled,
  type S7SearchUiState,
} from './components/s7-search-state';
export { S7SearchWorkbench } from './components/s7-search-workbench';
export type {
  S7SearchWorkbenchLabels,
  S7SearchWorkbenchProps,
} from './components/s7-search-workbench';
export type {
  Column,
  Density,
  KnowledgeDataTableProps,
  TablePagination,
} from './components/data-table';
export { KnowledgeAppShell } from './components/knowledge-shell';
export type { ShellLocation } from './components/knowledge-shell';
export {
  S7_SEARCH_MODES,
  S7_TAG_OPERATORS,
  S7_TAG_TYPES,
  S7SearchFormSchema,
  addTagCondition,
  buildS7SearchFilters,
  buildS7SearchRequest,
  defaultS7SearchForm,
  patchTagCondition,
  tagConditionFromDraft,
} from './forms/s7-search-form';
export type { S7SearchFormValues, S7SearchMode, S7TagType } from './forms/s7-search-form';
export {
  collaboratorFormSchema,
  fieldErrorsFromProblem,
  FormField,
  newSpaceFormSchema,
  segmentFormSchema,
  sourceFormSchema,
  submitWithProblem,
  tagAssignmentFormSchema,
  tagFormSchema,
  updateSpaceFormSchema,
  useKnowledgeForm,
} from './forms/knowledge-form';
export {
  buildImportChunkingSettings,
  buildImportParseConfig,
  modelOptionsForType,
  parseChunkingSettingsDraft,
  parseModelBindingDraft,
  s5ChunkingSettingsFormSchema,
  s5ExternalOcrConfigFormSchema,
  s5LiteParseConfigFormSchema,
  s5ModelBindingFormSchema,
} from './forms/s5-model-parse-form';
export type {
  S5ChunkingSettingsView,
  S5ExternalOcrConfigView,
  S5LiteParseConfigView,
  S5ParseProviderConfigView,
} from './forms/s5-model-parse-form';
export type {
  CollaboratorFormValues,
  NewSpaceFormValues,
  SegmentFormValues,
  SourceFormValues,
  TagAssignmentFormValues,
  TagFormValues,
  UpdateSpaceFormValues,
} from './forms/knowledge-form';
export {
  enumMessageKey,
  formatDate,
  KnowledgeI18nProvider,
  messages,
  statusMessageKey,
  toProblemView,
  useKnowledgeEnumLabel,
  useKnowledgeI18n,
  type KnowledgeLocale,
  type MessageKey,
  type ProblemView,
} from './i18n';
export { createKnowledgeQueryClient, KnowledgeQueryProvider } from './query/knowledge-query-client';
export { knowledgeQueryKeys } from './query/query-keys';
export { loadCompleteModelCatalog, useKnowledgeModelCatalog } from './query/model-catalog';
export type { ModelCatalogPage, ModelPageInfo } from './query/model-catalog';
export { useKnowledgeMutation } from './query/use-knowledge-mutation';
export { useKnowledgeQuery } from './query/use-knowledge-query';
export { knowledgeGlobalStyles, knowledgeTheme, KnowledgeUiProvider } from './theme';
export { knowledgeThemeTokens } from './theme';
export type { KnowledgeThemeTokens } from './theme';
