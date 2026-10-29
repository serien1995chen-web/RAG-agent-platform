import {
  KnowledgeRequestError,
  PageHeader,
  ProblemNotice,
  S10ApiKeyManager,
  apiKeysPath,
  createApiKey,
  deleteApiKey,
  ensureConsoleSession,
  knowledgeQueryKeys,
  rotateApiKey,
  useKnowledgeI18n,
  useKnowledgeMutation,
  useKnowledgeQuery,
  type ConsoleSession,
  type S10ApiKey,
  type S10ApiKeyList,
  type S10ApiKeySecret,
} from '@kb/web';
import Head from 'next/head';
import { useEffect, useState } from 'react';

function forbiddenProblem(): KnowledgeRequestError {
  return new KnowledgeRequestError(403, {
    success: false,
    error: {
      code: 'KNOWLEDGE_FORBIDDEN',
      message: 'The resource is not available in this workspace.',
      retryable: false,
      details: {},
    },
    traceId: 'ui',
    requestId: 'ui',
  });
}

export default function ApiKeysPage() {
  const { t } = useKnowledgeI18n();
  const [session, setSession] = useState<ConsoleSession | null>(null);
  const [secret, setSecret] = useState<S10ApiKeySecret | null>(null);
  const keys = useKnowledgeQuery<S10ApiKeyList>(
    knowledgeQueryKeys.apiKeys.list(),
    apiKeysPath({ limit: '200' }),
  );

  useEffect(() => {
    void ensureConsoleSession()
      .then(setSession)
      .catch(() => setSession(null));
  }, []);

  const create = useKnowledgeMutation<
    S10ApiKeySecret,
    {
      name: string;
      scopes: S10ApiKey['scopes'];
      spaceIds: string[];
      expiresAt: string | null;
    }
  >({
    mutationFn: (input) => createApiKey(input),
    invalidateKeys: [knowledgeQueryKeys.apiKeys.list()],
    onSuccess: setSecret,
  });
  const rotate = useKnowledgeMutation<S10ApiKeySecret, S10ApiKey>({
    mutationFn: (key) => rotateApiKey(key.id, key.version),
    invalidateKeys: [knowledgeQueryKeys.apiKeys.list()],
    onSuccess: setSecret,
  });
  const revoke = useKnowledgeMutation<void, S10ApiKey>({
    mutationFn: (key) => deleteApiKey(key.id, key.version),
    invalidateKeys: [knowledgeQueryKeys.apiKeys.list()],
  });

  const authorized = session?.isWorkspaceOwner || session?.scopes.includes('knowledge:admin');
  const busy = create.isLoading || rotate.isLoading || revoke.isLoading;
  return (
    <>
      <Head>
        <title>{t('apiKeys.title')}</title>
      </Head>
      <PageHeader
        eyebrow={t('apiKeys.eyebrow')}
        title={t('apiKeys.heading')}
        description={t('apiKeys.description')}
      />
      {session && !authorized ? (
        <ProblemNotice error={forbiddenProblem()} />
      ) : (
        <S10ApiKeyManager
          items={keys.data?.items ?? []}
          loading={keys.isLoading}
          error={create.error ?? rotate.error ?? revoke.error ?? keys.error}
          secret={secret}
          busy={busy}
          onCreate={(input) => void create.mutateAsync(input)}
          onRotate={(key) => void rotate.mutateAsync(key)}
          onRevoke={(key) => void revoke.mutateAsync(key)}
          onClearSecret={() => setSecret(null)}
          onRetry={() => void keys.refetch()}
        />
      )}
    </>
  );
}
