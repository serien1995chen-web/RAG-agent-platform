import { createKnowledgeError } from '@kb/contracts';
import type { Connection, Types } from 'mongoose';
import type { FilterTagDefinition, SourceFilterFacts } from '@kb/search';
import type {
  KnowledgeDirectoryDoc,
  KnowledgeSourceDoc,
} from '../../../shared/persistence/schemas/knowledge-catalog.schemas';
import type { KnowledgeTagDoc } from '../../../shared/persistence/schemas/knowledge-taxonomy.schemas';
import { registerKnowledgeModels } from '../../../shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import { objectIdOf, requireWorkspaceId } from '../../../shared/persistence/knowledge/tenant';

type Plain<T> = T & { _id: Types.ObjectId };

export class S7FilterSourceRepository {
  constructor(private readonly connection: Connection) {}

  async listFilterFacts(
    spaceId: string,
    sourceIds: readonly string[] | undefined,
    context: TenantContext,
  ) {
    try {
      return await this.readFilterFacts(spaceId, sourceIds, context);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'problem' in error) throw error;
      throw createKnowledgeError({
        code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { dependency: 'mongo', operation: 'search_filter_facts' },
      });
    }
  }

  private async readFilterFacts(
    spaceId: string,
    sourceIds: readonly string[] | undefined,
    context: TenantContext,
  ) {
    const workspaceId = requireWorkspaceId(context);
    if (sourceIds !== undefined && sourceIds.length === 0) {
      return { facts: [], definitions: [] };
    }
    const models = registerKnowledgeModels(this.connection);
    const knowledgeSpaceId = objectIdOf(spaceId, context, 'spaceId');
    const sourceFilter: Record<string, unknown> = {
      workspaceId,
      knowledgeSpaceId,
      deletedAt: null,
    };
    if (sourceIds !== undefined) {
      sourceFilter._id = {
        $in: sourceIds.map((sourceId) => objectIdOf(sourceId, context, 'filters.sourceIds')),
      };
    }
    const [sources, tags] = await Promise.all([
      models.KnowledgeSource.find(sourceFilter).lean(),
      models.KnowledgeTag.find({
        workspaceId,
        knowledgeSpaceId,
        deletedAt: null,
      }).lean(),
    ]);
    const sourceDocuments = sources as unknown as Array<Plain<KnowledgeSourceDoc>>;
    const directoryIds = [
      ...new Set(
        sourceDocuments
          .map((source) => source.directoryId)
          .filter((value): value is Types.ObjectId => value !== null),
      ),
    ];
    const directories =
      directoryIds.length === 0
        ? []
        : ((await models.KnowledgeDirectory.find({
            workspaceId,
            knowledgeSpaceId,
            _id: { $in: directoryIds },
            deletedAt: null,
          }).lean()) as unknown as Array<Plain<KnowledgeDirectoryDoc>>);
    const directoryById = new Map(
      directories.map((directory) => [String(directory._id), directory]),
    );
    const facts: SourceFilterFacts[] = sourceDocuments.map((source) => {
      const directory = source.directoryId
        ? directoryById.get(String(source.directoryId))
        : undefined;
      return {
        sourceId: String(source._id),
        knowledgeSpaceId: String(source.knowledgeSpaceId),
        directoryId: source.directoryId ? String(source.directoryId) : null,
        directoryPath: [
          ...new Set([
            ...(directory?.path ?? []).map(String),
            ...(directory ? [String(directory._id)] : []),
          ]),
        ],
        createdAt: source.createdAt,
        tagValues: source.tagValues.map((entry) => ({
          tagId: String(entry.tagId),
          valueKey: entry.valueKey,
          value: entry.value,
        })),
      };
    });
    const definitions: FilterTagDefinition[] = (
      tags as unknown as Array<Plain<KnowledgeTagDoc>>
    ).map((tag) => ({
      tagId: String(tag._id),
      knowledgeSpaceId: String(tag.knowledgeSpaceId),
      tagType: tag.tagType,
      status: tag.status,
    }));
    return { facts, definitions };
  }
}
