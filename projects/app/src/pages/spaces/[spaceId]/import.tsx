import {
  ImportWorkbench,
  LoadingState,
  PageHeader,
  ProblemNotice,
  S5ParseSettingsPanel,
  Section,
  buildImportChunkingSettings,
  buildImportParseConfig,
  knowledgeQueryKeys,
  useKnowledgeI18n,
  useKnowledgeQuery,
  type S5ChunkingSettingsView,
  type S5ParseProviderConfigView,
} from '@kb/web';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useState } from 'react';
import type { SpaceRecord } from '../../../lib/knowledge-types';

const initialChunking: S5ChunkingSettingsView = {
  trainingType: 'chunk',
  chunkSettingMode: 'auto',
  chunkSplitMode: 'paragraph',
  paragraphChunkMinSize: 100,
  chunkSize: 1_000,
};

const initialProvider: S5ParseProviderConfigView = {
  provider: 'liteparse',
  ocrEnabled: false,
  maxPages: 100_000,
  batchPages: 100,
  fallbackPdfJsOnWasmLoadError: true,
  timeoutMs: 600_000,
};

export default function ImportPage() {
  const router = useRouter();
  const { t } = useKnowledgeI18n();
  const spaceId = typeof router.query.spaceId === 'string' ? router.query.spaceId : '';
  const initialKind =
    typeof router.query.kind === 'string' &&
    [
      'files',
      'text',
      'url',
      'template',
      'backup',
      'api_library',
      'feishu',
      'yuque',
      'dingtalk',
    ].includes(router.query.kind)
      ? (router.query.kind as
          | 'files'
          | 'text'
          | 'url'
          | 'template'
          | 'backup'
          | 'api_library'
          | 'feishu'
          | 'yuque'
          | 'dingtalk')
      : 'files';
  const initialDirectoryId =
    typeof router.query.directoryId === 'string' ? router.query.directoryId : '';
  const [chunking, setChunking] = useState<S5ChunkingSettingsView>(initialChunking);
  const [provider, setProvider] = useState<S5ParseProviderConfigView>(initialProvider);
  const [previewed, setPreviewed] = useState(false);
  const space = useKnowledgeQuery<SpaceRecord>(
    knowledgeQueryKeys.spaces.detail(spaceId),
    spaceId ? `/v1/knowledge/spaces/${spaceId}` : null,
  );

  return (
    <>
      <Head>
        <title>
          {space.data ? t('import.title', { name: space.data.name }) : t('import.fallbackTitle')}
        </title>
      </Head>
      <PageHeader
        eyebrow={t('import.eyebrow')}
        title={t('import.heading')}
        description={t('import.description')}
      />
      <ProblemNotice error={space.error} onRetry={() => void space.refetch()} />
      <Section title={t('import.uploadTitle')} meta={t('import.uploadMeta')}>
        {!spaceId ? <LoadingState label={t('import.noSpace')} /> : null}
        {spaceId ? (
          <ImportWorkbench
            spaceId={spaceId}
            initialKind={initialKind}
            initialDirectoryId={initialDirectoryId}
            s5ParseConfig={buildImportParseConfig(provider)}
            s5ChunkingSettings={buildImportChunkingSettings(chunking)}
          />
        ) : null}
        {spaceId ? (
          <S5ParseSettingsPanel
            value={chunking}
            providerConfig={provider}
            verification={provider.provider === 'liteparse' ? 'real' : 'unverified'}
            onChange={setChunking}
            onProviderConfigChange={setProvider}
            onPreview={() => setPreviewed(true)}
            labels={{
              title: t('parseSettings.title'),
              parser: t('parseSettings.parser'),
              providerProfile: t('parseSettings.credentialProfile'),
              fallback: t('parseSettings.fallback'),
              imageHandling: t('parseSettings.imageHandling'),
              training: t('parseSettings.training'),
              mode: t('parseSettings.mode'),
              split: t('parseSettings.split'),
              chunkSize: t('parseSettings.chunkSize'),
              minSize: t('parseSettings.minSize'),
              splitter: t('parseSettings.splitter'),
              qaPrompt: t('parseSettings.qaPrompt'),
              preview: t('parseSettings.preview'),
              noJob: t('parseSettings.noJob'),
              providerLiteparse: t('parseSettings.provider.liteparse'),
              providerSangfor: t('parseSettings.provider.sangfor'),
              providerSomark: t('parseSettings.provider.somark'),
              providerTextin: t('parseSettings.provider.textin'),
              providerDoc2x: t('parseSettings.provider.doc2x'),
              fallbackLiteparse: t('parseSettings.provider.liteparse'),
              fallbackNone: t('parseSettings.fallback.none'),
              pdfFallback: t('parseSettings.pdfFallback'),
              imageUpload: t('parseSettings.image.upload'),
              imageKeepUrl: t('parseSettings.image.keepUrl'),
              imageDrop: t('parseSettings.image.drop'),
              trainingChunk: t('parseSettings.training.chunk'),
              trainingQa: t('parseSettings.training.qa'),
              trainingImageParse: t('parseSettings.training.imageParse'),
              trainingBackup: t('parseSettings.training.backup'),
              trainingTemplate: t('parseSettings.training.template'),
              modeAuto: t('parseSettings.mode.auto'),
              modeIntelligent: t('parseSettings.mode.intelligent'),
              modeCustom: t('parseSettings.mode.custom'),
              splitParagraph: t('parseSettings.split.paragraph'),
              splitSize: t('parseSettings.split.size'),
              splitChar: t('parseSettings.split.char'),
            }}
          />
        ) : null}
        {previewed ? (
          <span role="status" aria-live="polite">
            {t('parseSettings.noJob')}
          </span>
        ) : null}
      </Section>
    </>
  );
}
