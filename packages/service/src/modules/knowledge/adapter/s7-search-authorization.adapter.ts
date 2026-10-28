import { createKnowledgeError } from '@kb/contracts';
import { Types, type Connection } from 'mongoose';
import type {
  AuthorizedCandidate,
  AuthorizedSegmentSnapshot,
  AuthorizedSourceSnapshot,
  Candidate,
  SearchEngineContext,
  SearchHydrationResult,
} from '@kb/search';
import type {
  S7AuthorizedSpace,
  S7CandidateAuthorizationPort,
  S7SearchAccessPort,
} from '../application/s7-search.ports';
import type { KnowledgeAccessRepository } from '../repository/access.repository';
import type {
  KnowledgeSegmentDoc,
  KnowledgeSourceDoc,
  KnowledgeSpaceDoc,
} from '../../../shared/persistence/schemas/knowledge-catalog.schemas';
import { registerKnowledgeModels } from '../../../shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import {
  objectIdOf,
  requireWorkspaceId,
  tenantError,
} from '../../../shared/persistence/knowledge/tenant';

type Plain<T> = T & { _id: Types.ObjectId };

function searchScopeError(context: TenantContext) {
  return createKnowledgeError({
    code: 'KNOWLEDGE_FORBIDDEN',
    requestId: context.requestId,
    traceId: context.traceId,
    details: { scope: 'knowledge:search' },
  });
}

function mongoUnavailable(context: TenantContext) {
  return createKnowledgeError({
    code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
    requestId: context.requestId,
    traceId: context.traceId,
    details: { dependency: 'mongo', operation: 'search_authorization' },
  });
}

function isKnowledgeError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'problem' in error;
}

function toSegment(document: Plain<KnowledgeSegmentDoc>): AuthorizedSegmentSnapshot {
  return {
    id: String(document._id),
    workspaceId: document.workspaceId,
    knowledgeSpaceId: String(document.knowledgeSpaceId),
    sourceId: String(document.sourceId),
    sourceVersion: document.sourceVersion,
    order: document.order,
    searchEnabled: document.searchEnabled,
    question: document.question,
    answer: document.answer,
    content: document.content,
    metadata: document.metadata,
    indexes: document.indexes.map((index) => ({
      indexId: index.indexId,
      type: index.type,
      modelId: index.modelId,
      dimension: index.dimension,
      vectorProfile: index.vectorProfile,
      vectorId: index.vectorId,
      text: index.text,
      version: index.version,
    })),
    indexStatus: document.indexStatus,
    indexErrorCode: document.indexErrorCode,
    imageBlobRefId: document.imageBlobRefId ? String(document.imageBlobRefId) : null,
    version: document.version,
    updatedAt: document.updatedAt.toISOString(),
  };
}

function toSource(document: Plain<KnowledgeSourceDoc>): AuthorizedSourceSnapshot {
  return {
    id: String(document._id),
    workspaceId: document.workspaceId,
    knowledgeSpaceId: String(document.knowledgeSpaceId),
    name: document.name,
    originalUrl: document.originalUrl,
    sourceVersion: document.sourceVersion,
    permissionRevision: document.permissionRevision,
    searchEnabled: document.searchEnabled,
    deletedAt: document.deletedAt ? document.deletedAt.toISOString() : null,
    updatedAt: document.updatedAt.toISOString(),
  };
}

export class S7SearchAuthorizationAdapter
  implements S7SearchAccessPort, S7CandidateAuthorizationPort
{
  constructor(
    private readonly connection: Connection,
    private readonly access: KnowledgeAccessRepository,
  ) {}

  assertSearchScope(context: TenantContext): void {
    if (context.isWorkspaceOwner || context.scopes.includes('knowledge:search')) return;
    throw searchScopeError(context);
  }

  async getAuthorizedSpace(spaceId: string, context: TenantContext): Promise<S7AuthorizedSpace> {
    try {
      await this.access.assertPermission('space', spaceId, 'read', context);
      const models = registerKnowledgeModels(this.connection);
      const space = await models.KnowledgeSpace.findOne({
        workspaceId: requireWorkspaceId(context),
        _id: objectIdOf(spaceId, context, 'knowledgeSpaceId'),
        deletedAt: null,
        status: 'active',
      }).lean();
      if (!space) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
      return {
        spaceId,
        workspaceId: space.workspaceId,
        sourcePermissionEnabled: space.sourcePermissionEnabled,
      };
    } catch (error) {
      if (isKnowledgeError(error)) throw error;
      throw mongoUnavailable(context);
    }
  }

  private async authorizedSpaceRevisions(
    spaceIds: readonly Types.ObjectId[],
    context: TenantContext,
  ): Promise<Map<string, number>> {
    const authorized = await Promise.all(
      spaceIds.map(async (spaceId) => {
        try {
          const resource = await this.access.assertPermission(
            'space',
            String(spaceId),
            'read',
            context,
          );
          return [String(spaceId), resource.permissionRevision] as const;
        } catch (error) {
          const code =
            typeof error === 'object' && error !== null && 'problem' in error
              ? (error as { problem?: { error?: { code?: unknown } } }).problem?.error?.code
              : undefined;
          if (code === 'KNOWLEDGE_NOT_FOUND') return undefined;
          throw error;
        }
      }),
    );
    return new Map(authorized.filter((entry) => entry !== undefined));
  }

  private async hydrateOne(
    candidates: readonly Candidate[],
    context: TenantContext,
  ): Promise<SearchHydrationResult> {
    const workspaceId = requireWorkspaceId(context);
    const models = registerKnowledgeModels(this.connection);
    const segmentIds = [
      ...new Set(
        candidates
          .map((candidate) => candidate.segmentId)
          .filter((value): value is string => Boolean(value) && Types.ObjectId.isValid(value!)),
      ),
    ].map((value) => new Types.ObjectId(value));
    if (segmentIds.length === 0) return { items: [], rejected: candidates.length };
    const segmentDocuments = (await models.KnowledgeSegment.find({
      workspaceId,
      _id: { $in: segmentIds },
      deletedAt: null,
    }).lean()) as unknown as Array<Plain<KnowledgeSegmentDoc>>;
    const segmentById = new Map(segmentDocuments.map((segment) => [String(segment._id), segment]));
    const sourceIds = [...new Set(segmentDocuments.map((segment) => String(segment.sourceId)))].map(
      (value) => new Types.ObjectId(value),
    );
    const spaceIds = [
      ...new Set(segmentDocuments.map((segment) => String(segment.knowledgeSpaceId))),
    ].map((value) => new Types.ObjectId(value));
    const [sourceDocuments, spaceDocuments, authorizedSources, authorizedSpaceRevisions] =
      await Promise.all([
        models.KnowledgeSource.find({
          workspaceId,
          _id: { $in: sourceIds },
          deletedAt: null,
        }).lean(),
        models.KnowledgeSpace.find({
          workspaceId,
          _id: { $in: spaceIds },
          deletedAt: null,
        }).lean(),
        this.access.batchAuthorizeSources(sourceIds.map(String), context),
        this.authorizedSpaceRevisions(spaceIds, context),
      ]);
    const sourceById = new Map(
      (sourceDocuments as unknown as Array<Plain<KnowledgeSourceDoc>>).map((source) => [
        String(source._id),
        source,
      ]),
    );
    const spaceById = new Map(
      (spaceDocuments as unknown as Array<Plain<KnowledgeSpaceDoc>>).map((space) => [
        String(space._id),
        space,
      ]),
    );
    const authorizedById = new Map(authorizedSources.map((source) => [source.sourceId, source]));
    let rejected = 0;
    const items = candidates.flatMap((candidate) => {
      if (!candidate.segmentId || !candidate.sourceId) {
        rejected += 1;
        return [];
      }
      const segment = segmentById.get(candidate.segmentId);
      const source = sourceById.get(candidate.sourceId);
      const authorized = authorizedById.get(candidate.sourceId);
      if (
        !segment ||
        !source ||
        !authorized ||
        String(segment.knowledgeSpaceId) !== candidate.knowledgeSpaceId ||
        String(segment.sourceId) !== candidate.sourceId ||
        String(source.knowledgeSpaceId) !== candidate.knowledgeSpaceId
      ) {
        rejected += 1;
        return [];
      }
      const space = spaceById.get(String(segment.knowledgeSpaceId));
      const spacePermissionRevision = authorizedSpaceRevisions.get(
        String(segment.knowledgeSpaceId),
      );
      if (
        !space ||
        spacePermissionRevision === undefined ||
        spacePermissionRevision !== space.permissionRevision ||
        space.status !== 'active' ||
        !segment.searchEnabled ||
        segment.indexStatus !== 'indexed' ||
        segment.sourceVersion !== source.sourceVersion ||
        !source.searchEnabled ||
        source.deletedAt !== null ||
        authorized.permissionRevision !== source.permissionRevision ||
        authorized.sourceVersion !== source.sourceVersion
      ) {
        rejected += 1;
        return [];
      }
      if (candidate.indexId) {
        const pointer = segment.indexes.find((index) => index.indexId === candidate.indexId);
        if (
          !pointer ||
          (candidate.indexVersion !== undefined && pointer.version !== candidate.indexVersion)
        ) {
          rejected += 1;
          return [];
        }
      }
      const currentFullTextVersion = (segment as unknown as { fullTextVersion?: string | number })
        .fullTextVersion;
      const isFullTextCandidate =
        candidate.fullTextScore !== undefined ||
        candidate.fullTextVersion !== undefined ||
        candidate.scores.some((entry) => entry.type === 'fullText');
      if (isFullTextCandidate && currentFullTextVersion === undefined) {
        rejected += 1;
        return [];
      }
      if (
        candidate.fullTextVersion !== undefined &&
        String(candidate.fullTextVersion) !== String(currentFullTextVersion)
      ) {
        rejected += 1;
        return [];
      }
      const segmentSnapshot = toSegment(segment);
      const sourceSnapshot = toSource(source);
      const text = [segment.question, segment.answer, segment.content]
        .filter((value) => value.length > 0)
        .join('\n');
      return [
        {
          ...candidate,
          segmentId: String(segment._id),
          sourceId: String(source._id),
          text,
          segment: segmentSnapshot,
          source: sourceSnapshot,
        } as AuthorizedCandidate,
      ];
    });
    return { items, rejected };
  }

  async hydrate(
    candidates: readonly Candidate[],
    context: SearchEngineContext,
  ): Promise<SearchHydrationResult> {
    const tenant: TenantContext = {
      workspaceId: context.workspaceId,
      requestId: context.requestId,
      memberId: context.memberId ?? '',
      traceId: context.traceId ?? context.requestId,
      ...(context.apiKeyId ? { apiKeyId: context.apiKeyId } : {}),
      scopes: context.scopes ?? [],
      isWorkspaceOwner: context.isWorkspaceOwner ?? false,
    };
    try {
      return await this.hydrateOne(candidates, tenant);
    } catch (error) {
      if (isKnowledgeError(error)) throw error;
      throw mongoUnavailable(tenant);
    }
  }

  async reauthorizeCitation(
    input: {
      knowledgeSpaceId: string;
      sourceId: string;
      segmentId: string;
    },
    context: TenantContext,
  ): Promise<AuthorizedCandidate | undefined> {
    const candidate: Candidate = {
      docId: `${input.knowledgeSpaceId}:${input.segmentId}`,
      segmentId: input.segmentId,
      sourceId: input.sourceId,
      knowledgeSpaceId: input.knowledgeSpaceId,
      score: 0,
      scores: [],
      text: '',
    };
    try {
      const result = await this.hydrateOne([candidate], context);
      return result.items[0];
    } catch (error) {
      if (isKnowledgeError(error)) throw error;
      throw mongoUnavailable(context);
    }
  }
}
