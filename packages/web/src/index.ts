export {
  ensureConsoleSession,
  knowledgeRequest,
  KnowledgeRequestError,
  useKnowledgeRequest,
} from './client/knowledge-client';
export type { ConsoleSession } from './client/knowledge-client';
export {
  Button,
  DataTable,
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
  formatDate,
} from './components/knowledge-primitives';
export type { Column } from './components/knowledge-primitives';
export { KnowledgeAppShell } from './components/knowledge-shell';
export type { ShellLocation } from './components/knowledge-shell';
