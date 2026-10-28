import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import type { DeepSearchApiResponse } from '../../packages/contracts/src';
import { S8DeepSearchPanel } from '../../packages/web/src/components/s8-deep-search-panel';
import type { S8DeepSearchPanelLabels } from '../../packages/web/src/components/s8-deep-search-panel';
import { S8ImagesWorkbench } from '../../packages/web/src/components/s8-images-workbench';
import type { S8ImagesWorkbenchLabels } from '../../packages/web/src/components/s8-images-workbench';
import { defaultS8SearchForm } from '../../packages/web/src/forms/s8-search-form';
import { KnowledgeUiProvider } from '../../packages/web/src/theme/knowledge-ui-provider';

const spaceId = '65f1e5b2a1c9d4b7e8f01234';
const imageOne = '65f1e5b2a1c9d4b7e8f30001';
const imageTwo = '65f1e5b2a1c9d4b7e8f30002';
const sourceId = '65f1e5b2a1c9d4b7e8f05678';
const segmentId = '65f1e5b2a1c9d4b7e8f20001';
const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const imageLabels: S8ImagesWorkbenchLabels = {
  title: 'Image knowledge',
  description: 'Upload controlled images and inspect caption and vector status.',
  uploadTitle: 'Upload images',
  uploadHint: 'PNG or JPEG, up to 10 images.',
  choose: 'Choose images',
  upload: 'Upload images',
  uploading: 'Uploading',
  uploaded: 'Upload completed.',
  uploadFailed: 'Upload failed.',
  invalidType: 'Unsupported image format.',
  tooLarge: 'Image too large.',
  tooMany: 'Too many images.',
  searchTitle: 'Image search',
  query: 'Query',
  queryPlaceholder: 'Describe the image',
  selectedImages: 'Selected images',
  search: 'Search images',
  searching: 'Searching',
  partial: 'Some image channels are unavailable.',
  providerError: 'Image search is unavailable.',
  retry: 'Retry',
  empty: 'No images.',
  preview: 'Preview',
  loadingPreview: 'Loading preview',
  previewExpired: 'Preview expired.',
  caption: 'Caption',
  captionStatus: 'Caption status',
  vectorStatus: 'Vector status',
  close: 'Close',
};

const deepLabels: S8DeepSearchPanelLabels = {
  title: 'Deep search',
  description: 'Bounded multi-round search with visible budget and stop reason.',
  query: 'Query',
  queryPlaceholder: 'Compare refund and escalation policy',
  maxRounds: 'Maximum rounds',
  roundTokenBudget: 'Round token budget',
  tokenBudget: 'Total token budget',
  stopWhenNoNewEvidence: 'Stop without new evidence',
  run: 'Run deep search',
  running: 'Running',
  idle: 'Enter a question.',
  partial: 'Deep search completed partially.',
  rounds: 'Rounds',
  round: 'Round',
  candidateCount: 'Candidates',
  sufficient: 'Sufficient',
  stopReason: 'Stop reason',
  usage: 'Usage',
  error: 'Deep search failed.',
  retry: 'Retry',
  citation: {
    citation: 'Citation',
    source: 'Source',
    range: 'Range',
    version: 'Version',
  },
};

const deepResult: DeepSearchApiResponse = {
  searchId: 'search_fixture',
  mode: 'multi_space',
  items: [
    {
      segment: {
        id: segmentId,
        workspaceId: 'ws_fixture',
        knowledgeSpaceId: spaceId,
        sourceId,
        searchEnabled: true,
        order: 0,
        question: 'How long does a refund take?',
        answer: '',
        content: 'Refunds are processed within five business days.',
        metadata: {},
        indexes: [],
        indexStatus: 'indexed',
        indexErrorCode: null,
        imageBlobRefId: null,
        version: 1,
      },
      score: 0.88,
      citation: {
        citationId: 'cit_00000000-0000-4000-8000-000000000001',
        segmentId,
        sourceId,
        title: 'Support policy',
        sourceUrl: null,
        segmentRange: { start: 0, end: 48 },
        score: 0.88,
        version: 1,
      },
    },
  ],
  partial: true,
  durationMs: 1_200,
  degraded: ['deep_retrieval_partial'],
  rerankApplied: false,
  rounds: [
    {
      round: 1,
      queries: ['refund timing', 'refund escalation'],
      candidateCount: 2,
      sufficient: false,
    },
    { round: 2, queries: ['support lead review'], candidateCount: 1, sufficient: true },
  ],
  stopReason: 'dependency_failure',
  usage: { inputTokens: 2_000, outputTokens: 300 },
};

function ImagesFixture() {
  const [results, setResults] = useState<
    Array<{
      id: string;
      title: string;
      caption: string;
      citationId: string;
    }>
  >([]);
  return (
    <S8ImagesWorkbench
      spaceId={spaceId}
      items={[
        {
          id: sourceId,
          imageBlobRefId: imageOne,
          alt: 'Refund flow',
          caption: 'Refund flow diagram',
          captionStatus: 'indexed',
          vectorStatus: 'indexed',
        },
        {
          id: '65f1e5b2a1c9d4b7e8f05679',
          imageBlobRefId: imageTwo,
          alt: 'Support handoff',
          caption: 'Support handoff map',
          captionStatus: 'indexed',
          vectorStatus: 'error',
        },
      ]}
      labels={imageLabels}
      partial
      searchResults={results}
      onUpload={async () => [imageOne]}
      onPreview={async () => ({
        url: png,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      })}
      onSearch={async () => {
        setResults([
          {
            id: segmentId,
            title: 'Support policy',
            caption: 'Refunds are processed within five business days.',
            citationId: 'cit_fixture',
          },
        ]);
      }}
    />
  );
}

function DeepFixture() {
  const [value, setValue] = useState(() => ({
    ...defaultS8SearchForm(spaceId),
    query: 'Compare refund and escalation policy',
  }));
  return (
    <S8DeepSearchPanel
      value={value}
      labels={deepLabels}
      result={deepResult}
      state="ready"
      onChange={(next) => setValue((current) => ({ ...current, ...next }))}
      onSubmit={() => undefined}
      onRetry={() => undefined}
    />
  );
}

const panel = new URLSearchParams(globalThis.location.search).get('panel');
createRoot(document.getElementById('root')!).render(
  <KnowledgeUiProvider>
    {panel === 'deep' ? <DeepFixture /> : <ImagesFixture />}
  </KnowledgeUiProvider>,
);
