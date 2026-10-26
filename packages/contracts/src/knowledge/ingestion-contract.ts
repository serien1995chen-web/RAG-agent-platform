import { z } from 'zod';
import { ObjectIdSchema } from '../common/primitives';

export const IMPORT_KINDS = [
  'files',
  'text',
  'url',
  'template',
  'backup',
  'api_library',
  'feishu',
  'yuque',
  'dingtalk',
] as const;

export const CONNECTOR_PROVIDERS = ['custom_api', 'feishu', 'yuque', 'dingtalk'] as const;
export const CLOUD_CONNECTOR_PROVIDERS = ['feishu', 'yuque', 'dingtalk'] as const;
export const PARSE_PROVIDERS = ['liteparse', 'sangfor', 'somark', 'textin', 'doc2x'] as const;

export const JsonObjectSchema = z.record(z.string(), z.unknown());

export const ChunkingSettingsSchema = z
  .object({
    trainingType: z.enum(['chunk', 'qa', 'imageParse', 'backup', 'template']),
    chunkSettingMode: z.enum(['auto', 'custom', 'intelligent']),
    chunkSize: z.number().int().min(64).max(8000).optional(),
    overlap: z.number().int().min(0).max(8000).optional(),
  })
  .strict();

export const CustomApiConnectorConfigSchema = z
  .object({
    provider: z.literal('custom_api'),
    baseUrl: z.string().url(),
    basePath: z.string().max(512).optional(),
    catalogPath: z.literal('/v1/file/list'),
    detailPath: z.literal('/v1/file/detail'),
    contentPath: z.literal('/v1/file/content'),
    previewPath: z.literal('/v1/file/read'),
    pageMode: z.enum(['none', 'cursor', 'offset']).default('none'),
  })
  .strict();

export const CustomApiCredentialsSchema = z
  .object({
    provider: z.literal('custom_api'),
    authMode: z.enum(['none', 'bearer', 'api_key']),
    authorization: z.string().max(4096).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.authMode !== 'none' && !value.authorization) {
      context.addIssue({
        code: 'custom',
        path: ['authorization'],
        message: 'authorization is required for the selected auth mode',
      });
    }
  });

export const ConnectorConfigSchema = z.discriminatedUnion('provider', [
  CustomApiConnectorConfigSchema,
  z
    .object({
      provider: z.literal('feishu'),
      folderToken: z.string().min(1).max(512),
    })
    .strict(),
  z
    .object({
      provider: z.literal('yuque'),
      basePath: z.string().max(512).optional(),
    })
    .strict(),
  z
    .object({
      provider: z.literal('dingtalk'),
      operatorId: z.string().max(128).optional(),
      workspaceId: z.string().max(128).optional(),
      rootNodeId: z.string().max(128).optional(),
      workspaceName: z.string().max(200).optional(),
    })
    .strict(),
]);

export const ConnectorCredentialsSchema = z.discriminatedUnion('provider', [
  CustomApiCredentialsSchema,
  z
    .object({
      provider: z.literal('feishu'),
      appId: z.string().min(1).max(128),
      appSecret: z.string().min(1).max(512),
    })
    .strict(),
  z
    .object({
      provider: z.literal('yuque'),
      userId: z.string().min(1).max(128),
      token: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      provider: z.literal('dingtalk'),
      appKey: z.string().min(1).max(128),
      appSecret: z.string().min(1).max(512),
      userId: z.string().min(1).max(128),
    })
    .strict(),
]);

export const ImportFilesSchema = z
  .object({
    directoryId: ObjectIdSchema.nullable().optional(),
    uploadIds: z.array(z.string()).min(1).max(1000),
    parseProvider: z.enum(PARSE_PROVIDERS).default('liteparse'),
    parseConfig: JsonObjectSchema.default({}),
    chunking: ChunkingSettingsSchema,
  })
  .strict();

export const ImportTextSchema = z
  .object({
    knowledgeSpaceId: ObjectIdSchema,
    directoryId: ObjectIdSchema.nullable().optional(),
    name: z.string().min(1).max(240),
    text: z.string().max(10_000_000),
    chunking: ChunkingSettingsSchema,
  })
  .strict();

export const ImportUrlSchema = z
  .object({
    directoryId: ObjectIdSchema.nullable().optional(),
    url: z.string().url(),
    selector: z.string().max(500).default('body'),
  })
  .strict();

export const ImportTemplateSchema = z
  .object({
    uploadId: z.string().min(1),
    directoryId: ObjectIdSchema.nullable().optional(),
  })
  .strict();

export const ImportBackupSchema = z
  .object({
    uploadId: z.string().min(1),
    directoryId: ObjectIdSchema.nullable().optional(),
    dryRun: z.boolean().default(false),
    conflictStrategy: z.enum(['fail', 'skip', 'overwrite']).default('fail'),
  })
  .strict();

export const ImportApiLibrarySchema = z
  .object({
    config: CustomApiConnectorConfigSchema,
    credentials: CustomApiCredentialsSchema,
    fileIds: z.array(z.string().min(1)).min(1).max(1000),
    directoryId: ObjectIdSchema.nullable().optional(),
  })
  .strict();

export const ConnectorConnectSchema = z
  .object({
    provider: z.enum(CONNECTOR_PROVIDERS),
    name: z.string().min(1).max(120),
    credentials: ConnectorCredentialsSchema,
    config: ConnectorConfigSchema,
    syncEnabled: z.boolean().default(true),
    syncIntervalMinutes: z.number().int().min(15).max(1440).default(60),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.config.provider !== value.provider || value.credentials.provider !== value.provider) {
      context.addIssue({
        code: 'custom',
        path: ['provider'],
        message: 'provider, config.provider and credentials.provider must match',
      });
    }
  });

export const ConnectorUpdateSchema = z
  .object({
    version: z.number().int().min(1),
    name: z.string().min(1).max(120).optional(),
    credentials: ConnectorCredentialsSchema.optional(),
    config: ConnectorConfigSchema.optional(),
    syncEnabled: z.boolean().optional(),
    syncIntervalMinutes: z.number().int().min(15).max(1440).optional(),
    credentialKeyVersion: z.literal(1).optional(),
  })
  .strict();

export const ConnectorSyncSchema = z
  .object({
    full: z.boolean().default(false),
    expectedCursorVersion: z.number().int().min(1).optional(),
    reason: z.string().max(200).optional(),
  })
  .strict();

export const ConnectorCatalogRequestSchema = z
  .object({
    rootId: z.string().min(1),
  })
  .strict();

export const ConnectorImportSchema = z
  .object({
    externalIds: z.array(z.string().min(1)).min(1).max(1000),
    directoryId: ObjectIdSchema.nullable().optional(),
  })
  .strict();

export function credentialMetadataOf(
  provider: (typeof CONNECTOR_PROVIDERS)[number],
  credentials: z.infer<typeof ConnectorCredentialsSchema>,
) {
  const fields =
    provider === 'feishu'
      ? ['appSecret']
      : provider === 'yuque'
        ? ['token']
        : provider === 'dingtalk'
          ? ['appSecret']
          : ['authorization'];
  return {
    provider,
    schemaVersion: 1,
    keyVersion: 1,
    configured: true,
    redactedFields: fields.filter((field) => Object.hasOwn(credentials, field)),
  };
}
