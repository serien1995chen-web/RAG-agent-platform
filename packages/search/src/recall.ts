import { buildIndexVersion, createKnowledgeError } from '@kb/contracts';
import type { DegradedInfo, SearchRequest } from '@kb/contracts';
import type {
  Candidate,
  ChannelFailure,
  ChannelFailureKind,
  ChannelOutcome,
  RecallOutcome,
  SearchEngineDeps,
} from './types';

function validationError(request: SearchRequest, details: Record<string, unknown>) {
  return createKnowledgeError({
    code: 'KNOWLEDGE_VALIDATION_FAILED',
    requestId: request.requestId,
    traceId: request.requestId,
    details,
  });
}

function failureKind(error: unknown): ChannelFailureKind {
  const code =
    typeof error === 'object' && error !== null && 'problem' in error
      ? (error as { problem?: { error?: { code?: unknown } } }).problem?.error?.code
      : undefined;
  if (code === 'KNOWLEDGE_RATE_LIMITED' || code === 'KNOWLEDGE_QUOTA_EXCEEDED') {
    return 'rate_limit';
  }
  if (code === 'KNOWLEDGE_DEPENDENCY_TIMEOUT') return 'timeout';
  if (code === 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE') return 'unavailable';
  if (
    code === 'KNOWLEDGE_MODEL_FAILED' ||
    code === 'KNOWLEDGE_MODEL_OUTPUT_INVALID' ||
    code === 'KNOWLEDGE_PROVIDER_CONTRACT_INVALID'
  ) {
    return 'model';
  }
  return 'internal';
}

function failureStatus(kind: ChannelFailureKind): ChannelFailure['status'] {
  if (kind === 'rate_limit') return 429;
  if (kind === 'timeout') return 504;
  if (kind === 'unavailable') return 503;
  if (kind === 'model') return 502;
  return 500;
}

function channelFailure(channel: 'embedding' | 'fullText', error: unknown): ChannelFailure {
  const kind = failureKind(error);
  return {
    channel,
    kind,
    degradedCode: channel === 'embedding' ? 'vector_recall_failed' : 'fulltext_recall_failed',
    status: failureStatus(kind),
  };
}

function vectorCandidate(
  knowledgeSpaceId: string,
  hit: {
    segmentId: string;
    sourceId: string;
    indexId: string;
    version?: number;
    score: number;
  },
  index: number,
): Candidate {
  return {
    docId: `${knowledgeSpaceId}:${hit.segmentId}`,
    segmentId: hit.segmentId,
    sourceId: hit.sourceId,
    knowledgeSpaceId,
    score: hit.score,
    embeddingScore: hit.score,
    indexId: hit.indexId,
    ...(hit.version !== undefined ? { indexVersion: hit.version } : {}),
    scores: [{ type: 'embedding', value: hit.score, index }],
    text: '',
  };
}

function fullTextCandidate(
  knowledgeSpaceId: string,
  hit: {
    segmentId: string;
    sourceId: string;
    fullTextVersion?: string | number;
    score: number;
  },
  index: number,
): Candidate {
  return {
    docId: `${knowledgeSpaceId}:${hit.segmentId}`,
    segmentId: hit.segmentId,
    sourceId: hit.sourceId,
    knowledgeSpaceId,
    score: hit.score,
    fullTextScore: hit.score,
    ...(hit.fullTextVersion !== undefined ? { fullTextVersion: hit.fullTextVersion } : {}),
    scores: [{ type: 'fullText', value: hit.score, index }],
    text: '',
  };
}

function degradedForFailure(failure: ChannelFailure): DegradedInfo {
  return {
    stage: failure.channel === 'embedding' ? 'vector' : 'fullText',
    reason: failure.degradedCode,
  };
}

export async function recallCandidates(
  input: SearchRequest,
  deps: SearchEngineDeps,
  context: { requestId: string; workspaceId: string },
): Promise<RecallOutcome> {
  const knowledgeSpaceId = input.knowledgeSpaceIds[0];
  if (!knowledgeSpaceId) {
    throw validationError(input, { field: 'knowledgeSpaceIds', reason: 'required' });
  }
  if (input.imageQueries.length > 0) {
    throw validationError(input, {
      field: 'imageQueries',
      reason: 'image_search_not_supported_in_s7',
    });
  }
  const textQueries = input.textQueries.filter((query) => query.trim().length > 0);
  if (textQueries.length === 0) {
    throw validationError(input, { field: 'query', reason: 'required' });
  }

  const options = { timeoutMs: input.budgets?.recallTimeoutMs ?? 5_000 };
  const indexVersion =
    input.indexVersion ??
    input.versionPolicy?.pinned ??
    buildIndexVersion(input.models.embeddingModel, 1536, 'v1');
  const degraded: DegradedInfo[] = [];
  const items: Candidate[] = [];
  const outcomes: ChannelOutcome[] = [];
  const vectorLimit = input.searchMode === 'mixedRecall' ? 80 : 100;
  const fullTextLimit = input.searchMode === 'mixedRecall' ? 60 : 100;

  if (input.searchMode === 'embedding' || input.searchMode === 'mixedRecall') {
    try {
      for (const query of textQueries) {
        const vectors = await deps.embedding.embed(
          { models: input.models, texts: [query], options },
          context,
        );
        const vector = vectors[0];
        if (!vector) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_MODEL_OUTPUT_INVALID',
            requestId: input.requestId,
            traceId: input.requestId,
            details: { field: 'embedding', reason: 'empty_output' },
          });
        }
        const hits = await deps.vectors.embRecall(
          {
            workspaceId: context.workspaceId,
            knowledgeSpaceId,
            ...(input.sourceIds !== undefined ? { sourceIds: input.sourceIds } : {}),
            vector,
            limit: vectorLimit,
            indexVersion,
            options,
          },
          context,
        );
        hits.forEach((hit, index) => items.push(vectorCandidate(knowledgeSpaceId, hit, index)));
      }
      outcomes.push({ channel: 'embedding', attempted: true, succeeded: true });
    } catch (error) {
      const failure = channelFailure('embedding', error);
      outcomes.push({ channel: 'embedding', attempted: true, succeeded: false, failure });
      degraded.push(degradedForFailure(failure));
    }
  }

  if (input.searchMode === 'fullTextRecall' || input.searchMode === 'mixedRecall') {
    if (!deps.fullText) {
      const failure: ChannelFailure = {
        channel: 'fullText',
        kind: 'unavailable',
        degradedCode: 'fulltext_recall_failed',
        status: 503,
      };
      outcomes.push({ channel: 'fullText', attempted: true, succeeded: false, failure });
      degraded.push(degradedForFailure(failure));
    } else {
      try {
        for (const query of textQueries) {
          const hits = await deps.fullText.search(
            {
              knowledgeSpaceId,
              ...(input.sourceIds !== undefined ? { sourceIds: input.sourceIds } : {}),
              text: query,
              limit: fullTextLimit,
              options,
            },
            context,
          );
          hits.forEach((hit, index) => items.push(fullTextCandidate(knowledgeSpaceId, hit, index)));
        }
        outcomes.push({ channel: 'fullText', attempted: true, succeeded: true });
      } catch (error) {
        const failure = channelFailure('fullText', error);
        outcomes.push({ channel: 'fullText', attempted: true, succeeded: false, failure });
        degraded.push(degradedForFailure(failure));
      }
    }
  }

  return {
    items,
    degraded,
    outcomes,
    totalOutcomes: outcomes.length,
  };
}
