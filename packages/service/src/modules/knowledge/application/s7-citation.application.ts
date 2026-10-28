import { createHash } from 'node:crypto';
import { CitationApiSchema, createKnowledgeError } from '@kb/contracts';
import type { CitationApi } from '@kb/contracts';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type {
  S7CandidateAuthorizationPort,
  S7CitationPersistencePort,
  S7CitationSignerPort,
  S7SearchAccessPort,
} from './s7-search.ports';

function notFound(context: TenantContext) {
  return createKnowledgeError({
    code: 'KNOWLEDGE_NOT_FOUND',
    requestId: context.requestId,
    traceId: context.traceId,
    details: {},
  });
}

function safeSourceUrl(value: string | null): string | null {
  return value && /^https?:\/\//i.test(value) ? value : null;
}

function snapshotHash(input: {
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

export class S7CitationApplication {
  constructor(
    private readonly input: {
      access: S7SearchAccessPort;
      authorizations: S7CandidateAuthorizationPort;
      citations: S7CitationPersistencePort;
      signer: S7CitationSignerPort;
      now?: () => Date;
    },
  ) {}

  async get(citationId: string, context: TenantContext): Promise<CitationApi> {
    this.input.access.assertSearchScope(context);
    if (!this.input.signer.verify(citationId, context.workspaceId)) throw notFound(context);
    const record = await this.input.citations.findCurrent(citationId, context);
    if (!record) throw notFound(context);
    await this.input.access.getAuthorizedSpace(record.knowledgeSpaceId, context);
    const now = this.input.now?.() ?? new Date();
    if (record.expiresAt.getTime() <= now.getTime()) throw notFound(context);
    const candidate = await this.input.authorizations.reauthorizeCitation(
      {
        knowledgeSpaceId: record.knowledgeSpaceId,
        sourceId: record.sourceId,
        segmentId: record.segmentId,
      },
      context,
    );
    if (!candidate) throw notFound(context);
    const characters = [...candidate.text];
    if (
      record.segmentRange.start < 0 ||
      record.segmentRange.end < record.segmentRange.start ||
      record.segmentRange.end > characters.length
    ) {
      throw notFound(context);
    }
    const quoteText = characters.slice(record.segmentRange.start, record.segmentRange.end).join('');
    const sourceUrl = safeSourceUrl(candidate.source.originalUrl);
    const currentHash = snapshotHash({
      workspaceId: context.workspaceId,
      sourceId: candidate.sourceId,
      segmentId: candidate.segmentId,
      segmentVersion: candidate.segment.version,
      title: candidate.source.name,
      sourceUrl,
      quoteText,
    });
    if (currentHash !== record.snapshotHash) throw notFound(context);
    return CitationApiSchema.parse({
      citationId: record.citationId,
      segmentId: candidate.segmentId,
      sourceId: candidate.sourceId,
      title: candidate.source.name,
      sourceUrl,
      segmentRange: record.segmentRange,
      score: record.score,
      version: candidate.segment.version,
    });
  }
}
