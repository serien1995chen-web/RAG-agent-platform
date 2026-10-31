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
  useQueryClient,
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
  const queryClient = useQueryClient();
  const [session, setSession] = useState<ConsoleSession | null>(null);
  const [secret, setSecret] = useState<S10ApiKeySecret | null>(null);
  const [cacheRevision, setCacheRevision] = useState(0);
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
  });
  const rotate = useKnowledgeMutation<S10ApiKeySecret, S10ApiKey>({
    mutationFn: (key) => rotateApiKey(key.id, key.version),
    invalidateKeys: [knowledgeQueryKeys.apiKeys.list()],
  });
  const revoke = useKnowledgeMutation<void, S10ApiKey>({
    mutationFn: (key) => deleteApiKey(key.id, key.version),
    invalidateKeys: [knowledgeQueryKeys.apiKeys.list()],
  });

  const authorized = session?.isWorkspaceOwner || session?.scopes.includes('knowledge:admin');
  const busy = create.isLoading || rotate.isLoading || revoke.isLoading;

  const purgeSecretMutations = () => {
    create.reset();
    rotate.reset();
    queryClient.getMutationCache().clear();
    setCacheRevision((value) => value + 1);
  };

  const runCreate = async (input: {
    name: string;
    scopes: S10ApiKey['scopes'];
    spaceIds: string[];
    expiresAt: string | null;
  }) => {
    const result = await create.mutateAsync(input);
    setSecret(result);
    purgeSecretMutations();
  };

  const runRotate = async (key: S10ApiKey) => {
    const result = await rotate.mutateAsync(key);
    setSecret(result);
    purgeSecretMutations();
  };

  const clearSecret = () => {
    setSecret(null);
    purgeSecretMutations();
  };

  useEffect(
    () => () => {
      create.reset();
      rotate.reset();
      queryClient.getMutationCache().clear();
    },
    [create.reset, queryClient, rotate.reset],
  );

  const mutationCache = queryClient.getMutationCache().getAll();
  const mutationCacheHasSecret =
    secret !== null &&
    JSON.stringify(mutationCache.map((mutation) => mutation.state)).includes(secret.secret);

  return (
    <>
      <span
        data-testid="s10-api-key-mutation-cache"
        data-size={mutationCache.length}
        data-secret-present={mutationCacheHasSecret}
        data-revision={cacheRevision}
        hidden
      />
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
          onCreate={(input) => void runCreate(input).catch(() => undefined)}
          onRotate={(key) => void runRotate(key).catch(() => undefined)}
          onRevoke={(key) => void revoke.mutateAsync(key)}
          onClearSecret={clearSecret}
          onRetry={() => void keys.refetch()}
        />
      )}
    </>
  );
}
