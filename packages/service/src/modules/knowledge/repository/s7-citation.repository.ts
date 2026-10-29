import { createHash } from 'node:crypto';
import { createKnowledgeError, type CitationApi } from '@kb/contracts';
import type { AuthorizedCandidate } from '@kb/search';
import { Types, type ClientSession, type Connection } from 'mongoose';
import type {
  S7CitationIssueInput,
  S7CitationPersistencePort,
  S7CitationReaderRecord,
  S7CitationSignerPort,
  S7SearchPersistenceMode,
  S7SearchAuditPort,
} from '../application/s7-search.ports';
import { KnowledgeAuditRepository } from '../../../shared/persistence/knowledge/audit';
import { registerKnowledgeModels } from '../../../shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';

const HTTP_URL = /^https?:\/\//i;

export function citationSnapshotHash(input: {
  workspaceId: string;
  sourceId: string;
  segmentId: string;
  segmentVersion: number;
  title: string;
  sourceUrl: string | null;
  quoteText: string;
}): string {
  return createHash('sha256')
    .update(
      [
        input.workspaceId,
        input.sourceId,
        input.segmentId,
        String(input.segmentVersion),
        input.title,
        input.sourceUrl ?? '',
        input.quoteText,
      ].join('|'),
      'utf8',
    )
    .digest('hex');
}

function safeSourceUrl(value: string | null): string | null {
  return value && HTTP_URL.test(value) ? value : null;
}

function citationKey(knowledgeSpaceId: string, segmentId: string): string {
  return `${knowledgeSpaceId}:${segmentId}`;
}

function dependencyError(context: TenantContext) {
  return createKnowledgeError({
    code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
    requestId: context.requestId,
    traceId: context.traceId,
    details: { dependency: 'mongo', operation: 'citation_issue' },
  });
}

function deadlineError(context: TenantContext) {
  return createKnowledgeError({
    code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT',
    requestId: context.requestId,
    traceId: context.traceId,
    details: { dependency: 'citation_persistence', reason: 'deadline_exceeded' },
  });
}

function assertCitationDeadline(
  input: { deadlineAt?: number; signal?: AbortSignal },
  context: TenantContext,
): void {
  if (input.signal?.aborted || (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt)) {
    throw deadlineError(context);
  }
}

async function abortTransaction(session: ClientSession): Promise<void> {
  if (!session.inTransaction()) return;
  try {
    await session.abortTransaction();
  } catch {
    // The timeout remains the actionable failure after a best-effort abort.
  }
}

function isTransactionDeadlineError(error: unknown): boolean {
  return (
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 50) ||
    (error instanceof Error && error.name === 'MongoOperationTimeoutError')
  );
}

export class S7CitationRepository implements S7CitationPersistencePort, S7SearchAuditPort {
  private readonly audits: KnowledgeAuditRepository;

  constructor(
    private readonly connection: Connection,
    private readonly signer: S7CitationSignerPort,
  ) {
    this.audits = new KnowledgeAuditRepository(connection);
  }

  async issueWithAudit(
    input: S7CitationIssueInput,
    context: TenantContext,
  ): Promise<ReadonlyMap<string, CitationApi>> {
    const citations = new Map<string, CitationApi>();
    const session = await this.connection.startSession();
    const abort = () => void abortTransaction(session);
    input.signal?.addEventListener('abort', abort, { once: true });
    try {
      assertCitationDeadline(input, context);
      const startRemaining =
        input.deadlineAt === undefined ? undefined : Math.max(1, input.deadlineAt - Date.now());
      session.startTransaction(
        startRemaining === undefined ? {} : { maxCommitTimeMS: startRemaining },
      );
      assertCitationDeadline(input, context);
      const models = registerKnowledgeModels(this.connection);
      const now = input.now;
      const documents = input.candidates.map((candidate: AuthorizedCandidate) => {
        const citationId = this.signer.issue(context.workspaceId);
        const sourceUrl = safeSourceUrl(candidate.source.originalUrl);
        const quoteText = candidate.text;
        const segmentRange = candidate.citationRange ?? {
          start: 0,
          end: [...quoteText].length,
        };
        const score = candidate.rerankScore ?? candidate.embeddingScore ?? candidate.score;
        const snapshotHash = citationSnapshotHash({
          workspaceId: context.workspaceId,
          sourceId: candidate.sourceId,
          segmentId: candidate.segmentId,
          segmentVersion: candidate.segment.version,
          title: candidate.source.name,
          sourceUrl,
          quoteText,
        });
        citations.set(citationKey(candidate.knowledgeSpaceId, candidate.segmentId), {
          citationId,
          segmentId: candidate.segmentId,
          sourceId: candidate.sourceId,
          title: candidate.source.name,
          sourceUrl,
          segmentRange,
          score,
          version: candidate.segment.version,
        });
        return {
          workspaceId: context.workspaceId,
          knowledgeSpaceId: new Types.ObjectId(candidate.knowledgeSpaceId),
          version: 1,
          deletedAt: null,
          createdByMemberId: context.memberId,
          updatedByMemberId: context.memberId,
          citationId,
          searchRequestId: input.searchId,
          segmentId: new Types.ObjectId(candidate.segmentId),
          sourceId: new Types.ObjectId(candidate.sourceId),
          title: candidate.source.name,
          sourceUrl,
          segmentRange,
          score,
          snapshotHash,
          expiresAt: new Date(now.getTime() + 24 * 86_400_000),
          createdAt: now,
          updatedAt: now,
        };
      });
      if (documents.length > 0) {
        await models.KnowledgeCitation.create(documents, { session, ordered: true });
      }
      await this.audits.append(
        {
          knowledgeSpaceId: input.spaceId,
          action: 'knowledge.search',
          resourceType: 'space',
          resourceId: input.spaceId,
          outcome: 'succeeded',
          safeDiff: {
            searchId: input.searchId,
            searchMode: input.searchMode,
            resultCount: input.candidates.length,
            partial: input.partial,
            durationMs: input.durationMs,
            degradedCodes: [...input.degradedCodes].sort(),
            filterConditionCount: input.filterSummary?.conditionCount ?? 0,
            filterConditionHash: input.filterSummary?.conditionHash ?? null,
            queryExpansionSummary: input.queryExpansionSummary ?? {
              queryCount: 0,
              hitCount: 0,
              fallbackReasons: [],
              queryHashes: [],
              spaces: [],
            },
          },
        },
        context,
        session,
      );
      assertCitationDeadline(input, context);
      const commitRemaining =
        input.deadlineAt === undefined ? undefined : Math.max(1, input.deadlineAt - Date.now());
      await session.commitTransaction(
        commitRemaining === undefined ? {} : { timeoutMS: commitRemaining },
      );
      return citations;
    } catch (error) {
      await abortTransaction(session);
      if (
        input.signal?.aborted ||
        (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt) ||
        isTransactionDeadlineError(error)
      ) {
        throw deadlineError(context);
      }
      if (typeof error === 'object' && error !== null && 'problem' in error) {
        throw error;
      }
      throw dependencyError(context);
    } finally {
      input.signal?.removeEventListener('abort', abort);
      await session.endSession();
    }
  }

  async findCurrent(
    citationId: string,
    context: TenantContext,
  ): Promise<S7CitationReaderRecord | null> {
    try {
      const models = registerKnowledgeModels(this.connection);
      const document = await models.KnowledgeCitation.findOne({
        workspaceId: context.workspaceId,
        citationId,
        deletedAt: null,
      }).lean();
      if (!document) return null;
      return {
        citationId: document.citationId,
        searchRequestId: document.searchRequestId,
        knowledgeSpaceId: String(document.knowledgeSpaceId),
        segmentId: String(document.segmentId),
        sourceId: String(document.sourceId),
        title: document.title,
        sourceUrl: document.sourceUrl,
        segmentRange:
          typeof document.segmentRange === 'object' &&
          document.segmentRange !== null &&
          typeof (document.segmentRange as { start?: unknown }).start === 'number' &&
          typeof (document.segmentRange as { end?: unknown }).end === 'number'
            ? {
                start: (document.segmentRange as { start: number }).start,
                end: (document.segmentRange as { end: number }).end,
              }
            : { start: 0, end: 0 },
        score: document.score,
        snapshotHash: document.snapshotHash,
        expiresAt: document.expiresAt,
      };
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'problem' in error) {
        throw error;
      }
      throw dependencyError(context);
    }
  }

  async appendSearch(
    input: {
      searchId: string;
      searchMode: S7SearchPersistenceMode;
      spaceId: string;
      outcome: 'succeeded' | 'failed';
      partial: boolean;
      resultCount: number;
      degradedCodes: string[];
      durationMs: number;
      filterSummary?: { conditionCount: number; conditionHash: string };
      queryExpansionSummary?: Record<string, unknown>;
      failureCode?: string;
    },
    context: TenantContext,
  ): Promise<void> {
    await this.audits.appendStandalone(
      {
        knowledgeSpaceId: input.spaceId,
        action: 'knowledge.search',
        resourceType: 'space',
        resourceId: input.spaceId,
        outcome: input.outcome,
        safeDiff: {
          searchId: input.searchId,
          searchMode: input.searchMode,
          resultCount: input.resultCount,
          partial: input.partial,
          durationMs: input.durationMs,
          degradedCodes: [...input.degradedCodes].sort(),
          filterConditionCount: input.filterSummary?.conditionCount ?? 0,
          filterConditionHash: input.filterSummary?.conditionHash ?? null,
          queryExpansionSummary: input.queryExpansionSummary ?? {
            queryCount: 0,
            hitCount: 0,
            fallbackReasons: [],
            queryHashes: [],
            spaces: [],
          },
          failureCode: input.failureCode ?? null,
        },
      },
      context,
    );
  }
}
