import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { KnowledgeProblem } from '../../packages/contracts/src/index';
import {
  S09SynonymsWorkbench,
  type S09SynonymsWorkbenchLabels,
} from '../../packages/web/src/components/s09-synonyms-workbench';
import {
  synonymUiState,
  type S09SynonymUiState,
} from '../../packages/web/src/components/s09-synonym-state';
import type {
  S09SynonymConfigData,
  S09SynonymMappingData,
} from '../../packages/web/src/client/s09-synonym-client';
import { KnowledgeUiProvider } from '../../packages/web/src/theme/knowledge-ui-provider';

const spaceId = '65f1e5b2a1c9d4b7e8f01234';
const config: S09SynonymConfigData = {
  knowledgeSpaceId: spaceId,
  fileName: 'support-synonyms.csv',
  sizeBytes: 428,
  activeFileVersion: 4,
  enabled: true,
  schemaVersion: 2,
  status: 'active',
  mappingCount: 3,
  termCount: 7,
  version: 9,
  updatedAt: '2026-10-28T12:00:00.000Z',
  lastError: null,
};

const mappings: S09SynonymMappingData[] = [
  {
    logicalMappingId: '65f1e5b2a1c9d4b7e8f00001',
    fileVersion: 4,
    standardizedTerm: 'Refund',
    normalizedStandardizedTerm: 'refund',
    synonymTerms: ['reimbursement', 'return payment'],
    normalizedSynonymTerms: ['reimbursement', 'return payment'],
    fingerprint: 'a'.repeat(64),
  },
  {
    logicalMappingId: '65f1e5b2a1c9d4b7e8f00002',
    fileVersion: 4,
    standardizedTerm: 'Delivery',
    normalizedStandardizedTerm: 'delivery',
    synonymTerms: ['shipment'],
    normalizedSynonymTerms: ['shipment'],
    fingerprint: 'b'.repeat(64),
  },
  {
    logicalMappingId: '65f1e5b2a1c9d4b7e8f00003',
    fileVersion: 4,
    standardizedTerm: 'Invoice',
    normalizedStandardizedTerm: 'invoice',
    synonymTerms: ['billing statement'],
    normalizedSynonymTerms: ['billing statement'],
    fingerprint: 'c'.repeat(64),
  },
];

const labels: Partial<S09SynonymsWorkbenchLabels> = {
  title: 'Synonyms',
  description: '',
  file: 'Synonym file',
  chooseFile: 'Choose CSV, XLS, or XLSX',
  upload: 'Upload',
  update: 'Update version',
  enable: 'Enable',
  disable: 'Disable',
  rebuild: 'Rebuild index',
  delete: 'Delete',
  confirmDelete: 'Disable and remove the published version?',
  cancel: 'Cancel',
  download: 'Download CSV',
  mappings: 'Mappings',
  terms: 'terms',
  searchMappings: 'Search standard or synonym terms',
  search: 'Search',
  loadMore: 'Next page',
  standard: 'Standard term',
  synonyms: 'Synonyms',
  fingerprint: 'Fingerprint',
  version: 'Version',
  active: 'Active',
  disabled: 'Disabled',
  rebuilding: 'Rebuilding',
  failed: 'Failed',
  empty: 'No synonym file has been uploaded.',
  loading: 'Loading synonyms',
  noMappings: 'No matching mappings.',
  invalidFile: 'File validation failed',
  conflict: 'The version changed. Refresh before retrying.',
  rateLimited: 'Too many requests. Retry shortly.',
  permission: 'This action is unavailable.',
  payloadTooLarge: 'The file exceeds 10 MiB.',
  error: 'The operation failed.',
  retry: 'Retry',
  trace: 'Trace',
  code: 'Code',
  row: 'Row',
  column: 'Column',
  progress: 'Rebuild progress',
  fileTooLarge: 'The file must not exceed 10 MiB.',
  fileExtension: 'Only CSV, XLS, and XLSX are supported.',
  fileRequired: 'Choose a file.',
  fileEmpty: 'The file is empty.',
};

function problem(
  code: KnowledgeProblem['error']['code'],
  details: Record<string, unknown> = {},
): KnowledgeProblem {
  return {
    success: false,
    error: {
      code,
      message: code,
      retryable: code !== 'KNOWLEDGE_SYNONYM_INVALID',
      details,
    },
    traceId: 'trace-s9-fixture',
    requestId: 'request-s9-fixture',
  };
}

function initialProblem(name: string): KnowledgeProblem | null {
  if (name === 'invalid') {
    return problem('KNOWLEDGE_SYNONYM_INVALID', {
      diagnostics: [
        {
          rowNumber: 5,
          columnNumber: 2,
          messageKey: 'knowledge.synonym.invalid.cross_standard_conflict',
        },
      ],
      totalDiagnostics: 1,
      truncated: false,
    });
  }
  if (name === 'conflict') return problem('KNOWLEDGE_CONFLICT');
  if (name === 'rate_limited') return problem('KNOWLEDGE_RATE_LIMITED');
  if (name === 'payload_too_large') return problem('KNOWLEDGE_PAYLOAD_TOO_LARGE');
  return null;
}

function Harness() {
  const stateName = new URLSearchParams(globalThis.location.search).get('state') ?? 'ready';
  const [currentConfig, setCurrentConfig] = useState<S09SynonymConfigData | undefined>(
    stateName === 'empty' ? undefined : config,
  );
  const [currentProblem, setCurrentProblem] = useState<KnowledgeProblem | null>(() =>
    initialProblem(stateName),
  );
  const [loading, setLoading] = useState(stateName === 'loading');
  const [job, setJob] = useState(
    stateName === 'rebuilding'
      ? {
          jobId: '65f1e5b2a1c9d4b7e8f09999',
          status: 'running',
          progress: { stage: 'embed', percent: 62 },
        }
      : undefined,
  );
  let state: S09SynonymUiState = synonymUiState({
    loading,
    config: currentConfig,
    mappings,
    nextCursor: 'cursor-next',
    hasMore: true,
    job,
    problem: currentProblem,
  });
  if (stateName === 'rebuilding' && currentConfig) {
    state = {
      ...state,
      kind: 'rebuilding',
      config: { ...currentConfig, status: 'rebuilding' },
      job,
    };
  }
  if (stateName === 'failed' && currentConfig) {
    state = {
      kind: 'failed',
      config: {
        ...currentConfig,
        status: 'failed',
        lastError: { code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE', message: 'embedding failed' },
      },
      code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
      retryable: true,
    };
  }
  if (stateName === 'disabled' && currentConfig) {
    state = {
      kind: 'disabled',
      config: { ...currentConfig, status: 'disabled', enabled: false },
    };
  }

  const complete = () => {
    setLoading(true);
    setCurrentProblem(null);
    globalThis.setTimeout(() => {
      setLoading(false);
      setCurrentConfig({ ...config, version: config.version + 1 });
      setJob(undefined);
    }, 120);
  };

  return (
    <KnowledgeUiProvider>
      <S09SynonymsWorkbench
        state={state}
        canManage
        labels={labels}
        busy={loading}
        onUpload={complete}
        onUpdate={complete}
        onToggle={(enabled) => {
          setCurrentConfig((value) =>
            value
              ? {
                  ...value,
                  enabled,
                  status: enabled ? 'active' : 'disabled',
                  version: value.version + 1,
                }
              : value,
          );
        }}
        onDelete={() => {
          setCurrentConfig((value) =>
            value
              ? {
                  ...value,
                  enabled: false,
                  status: 'disabled',
                  version: value.version + 1,
                }
              : value,
          );
        }}
        onDownload={() => undefined}
        onRebuild={() => {
          setCurrentConfig((value) =>
            value ? { ...value, status: 'rebuilding', version: value.version + 1 } : value,
          );
          setJob({
            jobId: '65f1e5b2a1c9d4b7e8f09999',
            status: 'queued',
            progress: { percent: 1 },
          });
        }}
        onMappingSearch={() => undefined}
        onMappingPage={() => undefined}
        onRetry={complete}
      />
    </KnowledgeUiProvider>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
