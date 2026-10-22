import { createKnowledgeError } from '@kb/contracts';
import type { Connection, Model, Schema } from 'mongoose';
import {
  type KnowledgeApiKeyDoc,
  type KnowledgeCollaboratorDoc,
  type KnowledgeReferenceBindingDoc,
  type KnowledgeResourcePermissionDoc,
  KnowledgeApiKeySchema,
  KnowledgeCollaboratorSchema,
  KnowledgeReferenceBindingSchema,
  KnowledgeResourcePermissionSchema,
} from './knowledge-access.schemas';
import {
  type KnowledgeDirectoryDoc,
  type KnowledgeSegmentDoc,
  type KnowledgeSourceDoc,
  type KnowledgeSpaceDoc,
  KnowledgeDirectorySchema,
  KnowledgeSegmentSchema,
  KnowledgeSourceSchema,
  KnowledgeSpaceSchema,
} from './knowledge-catalog.schemas';
import {
  type KnowledgeConnectorCursorDoc,
  type KnowledgeConnectorDoc,
  KnowledgeConnectorCursorSchema,
  KnowledgeConnectorSchema,
} from './knowledge-connector.schemas';
import {
  type KnowledgeModelBindingDoc,
  type KnowledgeSynonymConfigDoc,
  type KnowledgeSynonymMappingDoc,
  KnowledgeModelBindingSchema,
  KnowledgeSynonymConfigSchema,
  KnowledgeSynonymMappingSchema,
} from './knowledge-governance.schemas';
import {
  type KnowledgeIdempotencyRecordDoc,
  type KnowledgeJobDoc,
  type KnowledgeJobStepDoc,
  type KnowledgeOutboxEventDoc,
  KnowledgeIdempotencyRecordSchema,
  KnowledgeJobSchema,
  KnowledgeJobStepSchema,
  KnowledgeOutboxEventSchema,
} from './knowledge-job.schemas';
import {
  type KnowledgeAuditEventDoc,
  type KnowledgeCitationDoc,
  type KnowledgeObjectRefDoc,
  type KnowledgeUsageEventDoc,
  KnowledgeAuditEventSchema,
  KnowledgeCitationSchema,
  KnowledgeObjectRefSchema,
  KnowledgeUsageEventSchema,
} from './knowledge-operations.schemas';
import {
  type KnowledgeTagDoc,
  type KnowledgeTagValueDoc,
  KnowledgeTagSchema,
  KnowledgeTagValueSchema,
} from './knowledge-taxonomy.schemas';

export interface KnowledgeSchemaEntry {
  modelName: string;
  collection: string;
  schema: Schema;
}

export const KNOWLEDGE_SCHEMA_REGISTRY: readonly KnowledgeSchemaEntry[] = [
  {
    modelName: 'KnowledgeSpace',
    collection: 'knowledge_spaces',
    schema: KnowledgeSpaceSchema,
  },
  {
    modelName: 'KnowledgeDirectory',
    collection: 'knowledge_directories',
    schema: KnowledgeDirectorySchema,
  },
  {
    modelName: 'KnowledgeSource',
    collection: 'knowledge_sources',
    schema: KnowledgeSourceSchema,
  },
  {
    modelName: 'KnowledgeSegment',
    collection: 'knowledge_segments',
    schema: KnowledgeSegmentSchema,
  },
  {
    modelName: 'KnowledgeSynonymConfig',
    collection: 'knowledge_synonym_configs',
    schema: KnowledgeSynonymConfigSchema,
  },
  {
    modelName: 'KnowledgeSynonymMapping',
    collection: 'knowledge_synonym_mappings',
    schema: KnowledgeSynonymMappingSchema,
  },
  {
    modelName: 'KnowledgeJob',
    collection: 'knowledge_jobs',
    schema: KnowledgeJobSchema,
  },
  {
    modelName: 'KnowledgeJobStep',
    collection: 'knowledge_job_steps',
    schema: KnowledgeJobStepSchema,
  },
  {
    modelName: 'KnowledgeTag',
    collection: 'knowledge_tags',
    schema: KnowledgeTagSchema,
  },
  {
    modelName: 'KnowledgeTagValue',
    collection: 'knowledge_tag_values',
    schema: KnowledgeTagValueSchema,
  },
  {
    modelName: 'KnowledgeResourcePermission',
    collection: 'knowledge_resource_permissions',
    schema: KnowledgeResourcePermissionSchema,
  },
  {
    modelName: 'KnowledgeCollaborator',
    collection: 'knowledge_collaborators',
    schema: KnowledgeCollaboratorSchema,
  },
  {
    modelName: 'KnowledgeReferenceBinding',
    collection: 'knowledge_reference_bindings',
    schema: KnowledgeReferenceBindingSchema,
  },
  {
    modelName: 'KnowledgeConnector',
    collection: 'knowledge_connectors',
    schema: KnowledgeConnectorSchema,
  },
  {
    modelName: 'KnowledgeConnectorCursor',
    collection: 'knowledge_connector_cursors',
    schema: KnowledgeConnectorCursorSchema,
  },
  {
    modelName: 'KnowledgeUsageEvent',
    collection: 'knowledge_usage_events',
    schema: KnowledgeUsageEventSchema,
  },
  {
    modelName: 'KnowledgeAuditEvent',
    collection: 'knowledge_audit_events',
    schema: KnowledgeAuditEventSchema,
  },
  {
    modelName: 'KnowledgeOutboxEvent',
    collection: 'knowledge_outbox_events',
    schema: KnowledgeOutboxEventSchema,
  },
  {
    modelName: 'KnowledgeObjectRef',
    collection: 'knowledge_object_refs',
    schema: KnowledgeObjectRefSchema,
  },
  {
    modelName: 'KnowledgeApiKey',
    collection: 'knowledge_api_keys',
    schema: KnowledgeApiKeySchema,
  },
  {
    modelName: 'KnowledgeIdempotencyRecord',
    collection: 'knowledge_idempotency_records',
    schema: KnowledgeIdempotencyRecordSchema,
  },
  {
    modelName: 'KnowledgeModelBinding',
    collection: 'knowledge_model_bindings',
    schema: KnowledgeModelBindingSchema,
  },
  {
    modelName: 'KnowledgeCitation',
    collection: 'knowledge_citations',
    schema: KnowledgeCitationSchema,
  },
];

export interface KnowledgeRegisteredModels {
  KnowledgeSpace: Model<KnowledgeSpaceDoc>;
  KnowledgeDirectory: Model<KnowledgeDirectoryDoc>;
  KnowledgeSource: Model<KnowledgeSourceDoc>;
  KnowledgeSegment: Model<KnowledgeSegmentDoc>;
  KnowledgeSynonymConfig: Model<KnowledgeSynonymConfigDoc>;
  KnowledgeSynonymMapping: Model<KnowledgeSynonymMappingDoc>;
  KnowledgeJob: Model<KnowledgeJobDoc>;
  KnowledgeJobStep: Model<KnowledgeJobStepDoc>;
  KnowledgeTag: Model<KnowledgeTagDoc>;
  KnowledgeTagValue: Model<KnowledgeTagValueDoc>;
  KnowledgeResourcePermission: Model<KnowledgeResourcePermissionDoc>;
  KnowledgeCollaborator: Model<KnowledgeCollaboratorDoc>;
  KnowledgeReferenceBinding: Model<KnowledgeReferenceBindingDoc>;
  KnowledgeConnector: Model<KnowledgeConnectorDoc>;
  KnowledgeConnectorCursor: Model<KnowledgeConnectorCursorDoc>;
  KnowledgeUsageEvent: Model<KnowledgeUsageEventDoc>;
  KnowledgeAuditEvent: Model<KnowledgeAuditEventDoc>;
  KnowledgeOutboxEvent: Model<KnowledgeOutboxEventDoc>;
  KnowledgeObjectRef: Model<KnowledgeObjectRefDoc>;
  KnowledgeApiKey: Model<KnowledgeApiKeyDoc>;
  KnowledgeIdempotencyRecord: Model<KnowledgeIdempotencyRecordDoc>;
  KnowledgeModelBinding: Model<KnowledgeModelBindingDoc>;
  KnowledgeCitation: Model<KnowledgeCitationDoc>;
}

function modelFor<TDoc>(connection: Connection, modelName: string, schema: Schema): Model<TDoc> {
  return (connection.models[modelName] ??
    connection.model(modelName, schema)) as unknown as Model<TDoc>;
}

export function registerKnowledgeModels(connection: Connection): KnowledgeRegisteredModels {
  return {
    KnowledgeSpace: modelFor<KnowledgeSpaceDoc>(connection, 'KnowledgeSpace', KnowledgeSpaceSchema),
    KnowledgeDirectory: modelFor<KnowledgeDirectoryDoc>(
      connection,
      'KnowledgeDirectory',
      KnowledgeDirectorySchema,
    ),
    KnowledgeSource: modelFor<KnowledgeSourceDoc>(
      connection,
      'KnowledgeSource',
      KnowledgeSourceSchema,
    ),
    KnowledgeSegment: modelFor<KnowledgeSegmentDoc>(
      connection,
      'KnowledgeSegment',
      KnowledgeSegmentSchema,
    ),
    KnowledgeSynonymConfig: modelFor<KnowledgeSynonymConfigDoc>(
      connection,
      'KnowledgeSynonymConfig',
      KnowledgeSynonymConfigSchema,
    ),
    KnowledgeSynonymMapping: modelFor<KnowledgeSynonymMappingDoc>(
      connection,
      'KnowledgeSynonymMapping',
      KnowledgeSynonymMappingSchema,
    ),
    KnowledgeJob: modelFor<KnowledgeJobDoc>(connection, 'KnowledgeJob', KnowledgeJobSchema),
    KnowledgeJobStep: modelFor<KnowledgeJobStepDoc>(
      connection,
      'KnowledgeJobStep',
      KnowledgeJobStepSchema,
    ),
    KnowledgeTag: modelFor<KnowledgeTagDoc>(connection, 'KnowledgeTag', KnowledgeTagSchema),
    KnowledgeTagValue: modelFor<KnowledgeTagValueDoc>(
      connection,
      'KnowledgeTagValue',
      KnowledgeTagValueSchema,
    ),
    KnowledgeResourcePermission: modelFor<KnowledgeResourcePermissionDoc>(
      connection,
      'KnowledgeResourcePermission',
      KnowledgeResourcePermissionSchema,
    ),
    KnowledgeCollaborator: modelFor<KnowledgeCollaboratorDoc>(
      connection,
      'KnowledgeCollaborator',
      KnowledgeCollaboratorSchema,
    ),
    KnowledgeReferenceBinding: modelFor<KnowledgeReferenceBindingDoc>(
      connection,
      'KnowledgeReferenceBinding',
      KnowledgeReferenceBindingSchema,
    ),
    KnowledgeConnector: modelFor<KnowledgeConnectorDoc>(
      connection,
      'KnowledgeConnector',
      KnowledgeConnectorSchema,
    ),
    KnowledgeConnectorCursor: modelFor<KnowledgeConnectorCursorDoc>(
      connection,
      'KnowledgeConnectorCursor',
      KnowledgeConnectorCursorSchema,
    ),
    KnowledgeUsageEvent: modelFor<KnowledgeUsageEventDoc>(
      connection,
      'KnowledgeUsageEvent',
      KnowledgeUsageEventSchema,
    ),
    KnowledgeAuditEvent: modelFor<KnowledgeAuditEventDoc>(
      connection,
      'KnowledgeAuditEvent',
      KnowledgeAuditEventSchema,
    ),
    KnowledgeOutboxEvent: modelFor<KnowledgeOutboxEventDoc>(
      connection,
      'KnowledgeOutboxEvent',
      KnowledgeOutboxEventSchema,
    ),
    KnowledgeObjectRef: modelFor<KnowledgeObjectRefDoc>(
      connection,
      'KnowledgeObjectRef',
      KnowledgeObjectRefSchema,
    ),
    KnowledgeApiKey: modelFor<KnowledgeApiKeyDoc>(
      connection,
      'KnowledgeApiKey',
      KnowledgeApiKeySchema,
    ),
    KnowledgeIdempotencyRecord: modelFor<KnowledgeIdempotencyRecordDoc>(
      connection,
      'KnowledgeIdempotencyRecord',
      KnowledgeIdempotencyRecordSchema,
    ),
    KnowledgeModelBinding: modelFor<KnowledgeModelBindingDoc>(
      connection,
      'KnowledgeModelBinding',
      KnowledgeModelBindingSchema,
    ),
    KnowledgeCitation: modelFor<KnowledgeCitationDoc>(
      connection,
      'KnowledgeCitation',
      KnowledgeCitationSchema,
    ),
  };
}

export async function ensureKnowledgeCollections(connection: Connection): Promise<void> {
  const db = connection.db;
  if (!db) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
      requestId: 'mongo-ensure',
      traceId: 'mongo-ensure',
      details: { dependency: 'mongo', reason: 'disconnected' },
    });
  }
  registerKnowledgeModels(connection);
  const existing = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((entry) => entry.name),
  );
  for (const entry of KNOWLEDGE_SCHEMA_REGISTRY) {
    if (!existing.has(entry.collection)) {
      try {
        await db.createCollection(entry.collection);
      } catch (error) {
        if ((error as { code?: number }).code !== 48) throw error;
      }
    }
    const model = connection.models[entry.modelName];
    if (!model) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_INTERNAL_ERROR',
        requestId: 'mongo-ensure',
        traceId: 'mongo-ensure',
        details: { reason: 'model_missing', modelName: entry.modelName },
      });
    }
    await model.syncIndexes();
  }
}
