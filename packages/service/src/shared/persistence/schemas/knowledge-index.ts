import { createKnowledgeError } from '@kb/contracts';
import type { Connection, Model, Schema } from 'mongoose';
import {
  KnowledgeApiKeySchema,
  KnowledgeCollaboratorSchema,
  KnowledgeReferenceBindingSchema,
  KnowledgeResourcePermissionSchema,
} from './knowledge-access.schemas';
import {
  KnowledgeDirectorySchema,
  KnowledgeSegmentSchema,
  KnowledgeSourceSchema,
  KnowledgeSpaceSchema,
} from './knowledge-catalog.schemas';
import {
  KnowledgeConnectorCursorSchema,
  KnowledgeConnectorSchema,
} from './knowledge-connector.schemas';
import {
  KnowledgeModelBindingSchema,
  KnowledgeSynonymConfigSchema,
  KnowledgeSynonymMappingSchema,
} from './knowledge-governance.schemas';
import {
  KnowledgeIdempotencyRecordSchema,
  KnowledgeJobSchema,
  KnowledgeJobStepSchema,
  KnowledgeOutboxEventSchema,
} from './knowledge-job.schemas';
import {
  KnowledgeAuditEventSchema,
  KnowledgeCitationSchema,
  KnowledgeObjectRefSchema,
  KnowledgeUsageEventSchema,
} from './knowledge-operations.schemas';
import { KnowledgeTagSchema, KnowledgeTagValueSchema } from './knowledge-taxonomy.schemas';

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

export type KnowledgeRegisteredModels = Record<string, Model<Record<string, unknown>>>;

export function registerKnowledgeModels(connection: Connection): KnowledgeRegisteredModels {
  const models: KnowledgeRegisteredModels = {};
  for (const entry of KNOWLEDGE_SCHEMA_REGISTRY) {
    models[entry.modelName] = (connection.models[entry.modelName] ??
      connection.model(entry.modelName, entry.schema)) as Model<Record<string, unknown>>;
  }
  return models;
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
