import { createHash, randomUUID } from 'node:crypto';
import type { ClientSession, Connection, Model, Types } from 'mongoose';
import { createKnowledgeError } from '@kb/contracts';
import type {
  ModelBindingInput,
  ModelBindingRepositoryPort,
  ModelBindingView,
  S5ModelType,
} from '../application/s5-model-ports';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import { objectIdOf, requireWorkspaceId } from '../../../shared/persistence/knowledge/tenant';
import { withMongoTransaction } from '../../../shared/persistence/with-mongo-transaction';
import { registerKnowledgeModels } from '../../../shared/persistence/schemas/knowledge-index';
import type { KnowledgeModelBindingDoc } from '../../../shared/persistence/schemas/knowledge-governance.schemas';
import type { KnowledgeSpaceDoc } from '../../../shared/persistence/schemas/knowledge-catalog.schemas';
import type { KnowledgeAuditEventDoc } from '../../../shared/persistence/schemas/knowledge-operations.schemas';

const TYPE_ORDER: readonly S5ModelType[] = ['llm', 'embedding', 'rerank', 'vlm', 'stt', 'tts'];

interface BindingDocument extends KnowledgeModelBindingDoc {
  _id: Types.ObjectId;
}

interface S09ModelChangeRebuildBridge {
  requestModelChangeRebuildInSession(
    input: {
      spaceId: string;
      targetModelId: string;
      targetDimension: 768 | 1024 | 1536 | 3072;
    },
    context: TenantContext,
    session: ClientSession,
  ): Promise<unknown>;
}

function bindingView(document: BindingDocument): ModelBindingView {
  return {
    modelType: document.modelType,
    modelId: document.modelId,
    displayName: document.displayName,
    requiredCapabilities: [...document.requiredCapabilities].sort(),
    status: document.status,
  };
}

function sortedBindings(items: readonly ModelBindingView[]): ModelBindingView[] {
  return [...items].sort(
    (left, right) =>
      TYPE_ORDER.indexOf(left.modelType) - TYPE_ORDER.indexOf(right.modelType) ||
      left.modelId.localeCompare(right.modelId),
  );
}

function mirrorOf(bindings: readonly ModelBindingInput[]): Record<string, unknown> {
  return Object.fromEntries(
    bindings.map((binding) => [
      binding.modelType,
      {
        modelId: binding.modelId,
        displayName: binding.displayName,
        requiredCapabilities: [...binding.requiredCapabilities].sort(),
        status: binding.status,
      },
    ]),
  );
}

function dimensionOfCapabilities(capabilities: readonly string[]): 768 | 1024 | 1536 | 3072 | null {
  const value = capabilities.find((capability) =>
    /^dimension:(768|1024|1536|3072)$/.test(capability),
  );
  return value ? (Number(value.split(':')[1]) as 768 | 1024 | 1536 | 3072) : null;
}

export class S5ModelBindingRepository implements ModelBindingRepositoryPort {
  private readonly spaces: Model<KnowledgeSpaceDoc>;
  private readonly bindings: Model<KnowledgeModelBindingDoc>;
  private readonly audits: Model<KnowledgeAuditEventDoc>;

  constructor(
    private readonly connection: Connection,
    private readonly synonymRebuild?: S09ModelChangeRebuildBridge,
  ) {
    const models = registerKnowledgeModels(connection);
    this.spaces = models.KnowledgeSpace;
    this.bindings = models.KnowledgeModelBinding;
    this.audits = models.KnowledgeAuditEvent;
  }

  async list(spaceId: string, context: TenantContext): Promise<ModelBindingView[]> {
    const workspaceId = requireWorkspaceId(context);
    const documents = await this.bindings
      .find({
        workspaceId,
        knowledgeSpaceId: objectIdOf(spaceId, context, 'spaceId'),
        deletedAt: null,
      })
      .lean<BindingDocument[]>()
      .exec();
    return sortedBindings(documents.map(bindingView));
  }

  async replace(
    spaceId: string,
    expectedVersion: number,
    bindings: readonly ModelBindingInput[],
    context: TenantContext,
  ): Promise<{ items: ModelBindingView[]; version: number }> {
    const workspaceId = requireWorkspaceId(context);
    const spaceObjectId = objectIdOf(spaceId, context, 'spaceId');
    return withMongoTransaction(this.connection, async (session) => {
      const existingEmbedding = await this.bindings
        .findOne({
          workspaceId,
          knowledgeSpaceId: spaceObjectId,
          modelType: 'embedding',
          deletedAt: null,
        })
        .session(session)
        .lean<BindingDocument>();
      const space = await this.spaces
        .findOneAndUpdate(
          {
            _id: spaceObjectId,
            workspaceId,
            version: expectedVersion,
            deletedAt: null,
            status: 'active',
          },
          {
            $set: {
              modelBindings: mirrorOf(bindings),
              updatedByMemberId: context.memberId,
            },
            $inc: { version: 1 },
          },
          { new: true, runValidators: true, session },
        )
        .lean<KnowledgeSpaceDoc>()
        .exec();
      if (!space) {
        const exists = await this.spaces.exists({
          _id: spaceObjectId,
          workspaceId,
          deletedAt: null,
          status: 'active',
        });
        throw createKnowledgeError({
          code: exists ? 'KNOWLEDGE_CONFLICT' : 'KNOWLEDGE_NOT_FOUND',
          requestId: context.requestId,
          traceId: context.traceId,
          details: { resourceId: spaceId, expectedVersion },
        });
      }
      await this.bindings.deleteMany(
        {
          workspaceId,
          knowledgeSpaceId: spaceObjectId,
        },
        { session },
      );
      const now = new Date();
      if (bindings.length > 0) {
        await this.bindings.insertMany(
          bindings.map((binding) => ({
            workspaceId,
            knowledgeSpaceId: spaceObjectId,
            version: 1,
            deletedAt: null,
            createdByMemberId: context.memberId,
            updatedByMemberId: context.memberId,
            modelType: binding.modelType,
            modelId: binding.modelId,
            displayName: binding.displayName,
            requiredCapabilities: [...binding.requiredCapabilities].sort(),
            status: binding.status,
            activeQueryModelId:
              binding.modelType === 'embedding'
                ? (existingEmbedding?.activeQueryModelId ?? binding.modelId)
                : null,
            activeQueryDimension:
              binding.modelType === 'embedding'
                ? (existingEmbedding?.activeQueryDimension ??
                  dimensionOfCapabilities(
                    existingEmbedding?.requiredCapabilities ?? binding.requiredCapabilities,
                  ))
                : null,
            authorizedAt: now,
          })),
          { session, ordered: true },
        );
      }
      const nextEmbedding = bindings.find(
        (binding) => binding.modelType === 'embedding' && binding.status === 'active',
      );
      const nextDimension = nextEmbedding
        ? dimensionOfCapabilities(nextEmbedding.requiredCapabilities)
        : null;
      if (
        nextEmbedding &&
        nextDimension &&
        this.synonymRebuild &&
        (existingEmbedding?.modelId !== nextEmbedding.modelId ||
          existingEmbedding?.activeQueryDimension !== nextDimension)
      ) {
        await this.synonymRebuild.requestModelChangeRebuildInSession(
          {
            spaceId,
            targetModelId: nextEmbedding.modelId,
            targetDimension: nextDimension,
          },
          context,
          session,
        );
      }
      await this.audits.create(
        [
          {
            workspaceId,
            knowledgeSpaceId: spaceObjectId,
            version: 1,
            deletedAt: null,
            createdByMemberId: context.memberId,
            updatedByMemberId: context.memberId,
            eventId: randomUUID(),
            action: 'space.model_bindings.update',
            actorMemberId: context.memberId,
            apiKeyId: null,
            resourceType: 'space',
            resourceId: spaceId,
            outcome: 'succeeded',
            traceId: context.traceId,
            requestId: context.requestId,
            ipHash: createHash('sha256').update(context.requestId).digest('hex'),
            userAgentHash: createHash('sha256').update(context.traceId).digest('hex'),
            safeDiff: {
              count: bindings.length,
              modelTypes: bindings.map((binding) => binding.modelType),
            },
            occurredAt: now,
            expiresAt: new Date(now.getTime() + 730 * 86_400_000),
          },
        ],
        { session, ordered: true },
      );
      return {
        items: sortedBindings(bindings.map((binding) => ({ ...binding }))),
        version: space.version,
      };
    });
  }
}
