import {
  S09SynonymClient,
  S09SynonymRequestError,
  S09SynonymsWorkbench,
  ensureConsoleSession,
  knowledgeQueryKeys,
  synonymUiState,
  useKnowledgeI18n,
  useKnowledgeQuery,
  type S09SynonymConfigData,
  type S09SynonymJobData,
  type S09SynonymMappingListData,
  type S09SynonymsWorkbenchLabels,
} from '@kb/web';
import type { KnowledgeProblem } from '@kb/contracts';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';

function queryString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function problemFrom(error: unknown): KnowledgeProblem | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    'problem' in error &&
    typeof (error as { problem?: unknown }).problem === 'object'
  ) {
    return (error as { problem: KnowledgeProblem }).problem;
  }
  return null;
}

export default function SynonymsPage() {
  const router = useRouter();
  const { t } = useKnowledgeI18n();
  const spaceId = queryString(router.query.spaceId);
  const [canManage, setCanManage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<KnowledgeProblem | null>(null);
  const [search, setSearch] = useState('');
  const [cursor, setCursor] = useState<string | undefined>();
  const config = useKnowledgeQuery<S09SynonymConfigData>(
    knowledgeQueryKeys.synonyms.detail(spaceId),
    spaceId ? `/v1/knowledge/spaces/${spaceId}/synonyms` : null,
  );
  const mappings = useKnowledgeQuery<S09SynonymMappingListData>(
    knowledgeQueryKeys.synonyms.mappings(spaceId, {
      cursor,
      search,
      limit: 50,
    }),
    spaceId
      ? `/v1/knowledge/spaces/${spaceId}/synonyms/mappings?limit=50${
          search ? `&search=${encodeURIComponent(search)}` : ''
        }${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      : null,
  );
  const jobs = useKnowledgeQuery<{
    items: Array<
      S09SynonymJobData & {
        knowledgeSpaceId: string;
        kind: string;
      }
    >;
  }>(
    knowledgeQueryKeys.jobs.list({ limit: 200, kind: 'synonym_rebuild' }),
    '/v1/knowledge/jobs?limit=200&kind=synonym_rebuild',
  );
  const synonymJob = jobs.data?.items.find(
    (job) => job.knowledgeSpaceId === spaceId && job.kind === 'synonym_rebuild',
  );

  useEffect(() => {
    let active = true;
    void ensureConsoleSession().then((session) => {
      if (!active) return;
      setCanManage(
        session.isWorkspaceOwner ||
          session.scopes.includes('knowledge:manage') ||
          session.scopes.includes('knowledge:admin'),
      );
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (config.data?.status !== 'rebuilding') return;
    const timer = window.setInterval(() => {
      void config.refetch();
      void jobs.refetch();
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [config.data?.status, config.refetch, jobs.refetch]);

  const queryProblem = problemFrom(config.error) ?? problemFrom(mappings.error) ?? problem;
  const state = synonymUiState({
    loading: config.isLoading || mappings.isLoading,
    config: config.data,
    mappings: mappings.data?.items,
    nextCursor: mappings.data?.nextCursor,
    hasMore: mappings.data?.hasMore,
    job: synonymJob,
    problem: queryProblem,
  });

  const client = async () =>
    new S09SynonymClient({
      workspaceId: (await ensureConsoleSession()).workspaceId,
    });

  const mutate = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
      await Promise.all([config.refetch(), mappings.refetch(), jobs.refetch()]);
    } catch (error) {
      setProblem(error instanceof S09SynonymRequestError ? error.problem : problemFrom(error));
    } finally {
      setBusy(false);
    }
  };

  const labels: S09SynonymsWorkbenchLabels = {
    title: t('s9.synonyms.title'),
    description: t('s9.synonyms.description'),
    file: t('s9.synonyms.file'),
    chooseFile: t('s9.synonyms.chooseFile'),
    upload: t('s9.synonyms.upload'),
    update: t('s9.synonyms.update'),
    replace: t('s9.synonyms.replace'),
    enable: t('s9.synonyms.enable'),
    disable: t('s9.synonyms.disable'),
    rebuild: t('s9.synonyms.rebuild'),
    delete: t('s9.synonyms.delete'),
    confirmDelete: t('s9.synonyms.confirmDelete'),
    cancel: t('s9.synonyms.cancel'),
    download: t('s9.synonyms.download'),
    mappings: t('s9.synonyms.mappings'),
    terms: t('s9.synonyms.terms'),
    searchMappings: t('s9.synonyms.searchMappings'),
    search: t('s9.synonyms.search'),
    loadMore: t('s9.synonyms.loadMore'),
    standard: t('s9.synonyms.standard'),
    synonyms: t('s9.synonyms.synonyms'),
    fingerprint: t('s9.synonyms.fingerprint'),
    version: t('s9.synonyms.version'),
    status: t('s9.synonyms.status'),
    active: t('s9.synonyms.active'),
    disabled: t('s9.synonyms.disabled'),
    rebuilding: t('s9.synonyms.rebuilding'),
    failed: t('s9.synonyms.failed'),
    empty: t('s9.synonyms.empty'),
    loading: t('s9.synonyms.loading'),
    noMappings: t('s9.synonyms.noMappings'),
    invalidFile: t('s9.synonyms.invalidFile'),
    conflict: t('s9.synonyms.conflict'),
    rateLimited: t('s9.synonyms.rateLimited'),
    permission: t('s9.synonyms.permission'),
    payloadTooLarge: t('s9.synonyms.payloadTooLarge'),
    error: t('s9.synonyms.error'),
    retry: t('s9.synonyms.retry'),
    trace: t('s9.synonyms.trace'),
    code: t('s9.synonyms.code'),
    row: t('s9.synonyms.row'),
    column: t('s9.synonyms.column'),
    progress: t('s9.synonyms.progress'),
    fileTooLarge: t('s9.synonyms.fileTooLarge'),
    fileExtension: t('s9.synonyms.fileExtension'),
    fileRequired: t('s9.synonyms.fileRequired'),
    fileEmpty: t('s9.synonyms.fileEmpty'),
  };

  return (
    <>
      <Head>
        <title>{t('s9.synonyms.title')}</title>
      </Head>
      <S09SynonymsWorkbench
        state={state}
        canManage={canManage}
        labels={labels}
        busy={busy}
        onUpload={(file, enabled) =>
          void mutate(async () => {
            const api = await client();
            await api.upload(spaceId, file, { enabled });
          })
        }
        onUpdate={(file, enabled, expectedFileVersion) =>
          void mutate(async () => {
            const api = await client();
            await api.update(spaceId, file, {
              enabled,
              expectedFileVersion,
            });
          })
        }
        onToggle={(enabled) => {
          const current = config.data;
          if (!current) return;
          void mutate(async () => {
            const api = await client();
            await api.toggle(spaceId, {
              enabled,
              version: current.version,
            });
          });
        }}
        onDelete={() => {
          const current = config.data;
          if (!current) return;
          void mutate(async () => {
            const api = await client();
            await api.delete(spaceId, { version: current.version });
          });
        }}
        onRebuild={() => {
          const current = config.data;
          if (!current) return;
          void mutate(async () => {
            const api = await client();
            await api.rebuild(spaceId, { version: current.version });
          });
        }}
        onDownload={(fileVersion) =>
          void mutate(async () => {
            const api = await client();
            const blob = await api.download(spaceId, fileVersion);
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = `synonyms-v${fileVersion}.csv`;
            anchor.click();
            URL.revokeObjectURL(url);
          })
        }
        onMappingSearch={(value) => {
          setCursor(undefined);
          setSearch(value.trim());
        }}
        onMappingPage={(nextCursor) => setCursor(nextCursor)}
        onRetry={() => {
          void config.refetch();
          void mappings.refetch();
          void jobs.refetch();
        }}
      />
    </>
  );
}
