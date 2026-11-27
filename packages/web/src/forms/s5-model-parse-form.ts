import { z } from 'zod';
import type {
  S5ModelBindingView,
  S5ModelType,
  S5ModelView,
} from '../components/s5-model-parse-state';

const ModelTypeSchema = z.enum(['llm', 'embedding', 'rerank', 'vlm', 'stt', 'tts']);

export const s5ModelBindingFormSchema = z.object({
  modelType: ModelTypeSchema,
  modelId: z.string().min(1, { message: 'validation.required' }),
  displayName: z.string().min(1, { message: 'validation.required' }),
  requiredCapabilities: z.array(z.string()),
  status: z.enum(['active', 'disabled']),
});

export const s5ChunkingSettingsFormSchema = z
  .object({
    trainingType: z.enum(['chunk', 'qa', 'imageParse', 'backup', 'template']),
    chunkSettingMode: z.enum(['auto', 'custom', 'intelligent']),
    chunkTriggerType: z.enum(['minSize', 'forceChunk', 'maxSize']).optional(),
    chunkTriggerMinSize: z.number().int().min(100).max(8_000).optional(),
    chunkSplitMode: z.enum(['paragraph', 'size', 'char']).optional(),
    paragraphChunkAIMode: z.enum(['auto', 'force', 'forbid']).optional(),
    paragraphChunkDeep: z.number().int().min(1).max(8).optional(),
    paragraphChunkMinSize: z.number().int().min(1).max(8_000).optional(),
    chunkSize: z.number().int().min(64).max(8_000).optional(),
    chunkSplitter: z.string().max(1_000).optional(),
    overlap: z.number().int().min(0).max(8_000).optional(),
    indexSize: z.number().int().min(1).max(8_000).optional(),
    dataEnhanceCollectionName: z.boolean().optional(),
    imageIndex: z.boolean().optional(),
    autoIndexes: z.boolean().optional(),
    indexPrefixTitle: z.boolean().optional(),
    qaPrompt: z.string().max(20_000).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.chunkSettingMode === 'custom' && value.chunkSize === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['chunkSize'],
        message: 'validation.required',
      });
    }
    if (
      value.overlap !== undefined &&
      value.chunkSize !== undefined &&
      value.overlap >= value.chunkSize
    ) {
      context.addIssue({
        code: 'custom',
        path: ['overlap'],
        message: 'validation.maxLength',
      });
    }
    if (
      value.chunkSize !== undefined &&
      ((value.chunkTriggerMinSize ?? 0) > value.chunkSize ||
        (value.paragraphChunkMinSize ?? 0) > value.chunkSize)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['chunkSize'],
        message: 'validation.minLength',
      });
    }
    if (value.chunkSplitter) {
      const rules = value.chunkSplitter.split(/\r?\n/).filter(Boolean);
      if (rules.length > 5 || rules.some((rule) => rule.length > 200)) {
        context.addIssue({
          code: 'custom',
          path: ['chunkSplitter'],
          message: 'validation.maxLength',
        });
      }
    }
    if (
      value.chunkSplitMode !== 'paragraph' &&
      (value.paragraphChunkAIMode !== undefined ||
        value.paragraphChunkDeep !== undefined ||
        value.paragraphChunkMinSize !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['chunkSplitMode'],
        message: 'validation.paragraphModeRequired',
      });
    }
    if (
      value.trainingType === 'qa' &&
      value.chunkSettingMode === 'custom' &&
      value.chunkSize !== undefined &&
      value.chunkSize < 1_000
    ) {
      context.addIssue({
        code: 'custom',
        path: ['chunkSize'],
        message: 'validation.minLength',
      });
    }
    if (value.qaPrompt !== undefined && value.trainingType !== 'qa') {
      context.addIssue({
        code: 'custom',
        path: ['qaPrompt'],
        message: 'validation.qaModeRequired',
      });
    }
  });

export const s5LiteParseConfigFormSchema = z
  .object({
    provider: z.literal('liteparse'),
    ocrEnabled: z.literal(false),
    maxPages: z.number().int().min(1).max(100_000),
    batchPages: z.number().int().min(1).max(100),
    fallbackPdfJsOnWasmLoadError: z.boolean(),
    timeoutMs: z.number().int().min(1_000).max(600_000),
  })
  .strict();

const externalOcrCommon = {
  credentialProfileId: z.string().min(1).max(128),
  fallbackProvider: z.enum(['liteparse', 'none']),
  imageHandling: z.enum(['upload_to_storage', 'keep_url', 'drop']),
  timeoutMs: z.number().int().min(1_000).max(600_000),
} as const;

export const s5ExternalOcrConfigFormSchema = z.discriminatedUnion('provider', [
  z
    .object({
      provider: z.literal('sangfor'),
      ...externalOcrCommon,
      keepHeaderFooter: z.boolean().optional(),
      keepAppendix: z.boolean().optional(),
      imageAnalysis: z.boolean().optional(),
      chartAnalysis: z.boolean().optional(),
    })
    .strict(),
  z.object({ provider: z.literal('somark'), ...externalOcrCommon }).strict(),
  z
    .object({
      provider: z.literal('textin'),
      ...externalOcrCommon,
      parseMode: z.enum(['auto', 'scan']),
      removeWatermark: z.boolean(),
    })
    .strict(),
  z
    .object({
      provider: z.literal('doc2x'),
      ...externalOcrCommon,
      pollIntervalMs: z.number().int().min(100).max(60_000),
    })
    .strict(),
]);

export type S5ChunkingSettingsView = z.infer<typeof s5ChunkingSettingsFormSchema>;
export type S5LiteParseConfigView = z.infer<typeof s5LiteParseConfigFormSchema>;
export type S5ExternalOcrConfigView = z.infer<typeof s5ExternalOcrConfigFormSchema>;
export type S5ParseProviderConfigView = S5LiteParseConfigView | S5ExternalOcrConfigView;

export function modelOptionsForType(
  models: readonly S5ModelView[],
  modelType: S5ModelType,
): Array<{ value: string; label: string; capabilities: string[] }> {
  return models
    .filter((model) => model.authorized && model.type === modelType)
    .sort((left, right) => left.modelId.localeCompare(right.modelId))
    .map((model) => ({
      value: model.modelId,
      label: model.displayName,
      capabilities: [...model.capabilities].sort(),
    }));
}

export function parseModelBindingDraft(value: unknown):
  | {
      success: true;
      data: S5ModelBindingView;
    }
  | {
      success: false;
      errors: Record<string, string>;
    } {
  const parsed = s5ModelBindingFormSchema.safeParse(value);
  if (parsed.success) return { success: true, data: parsed.data };
  return {
    success: false,
    errors: Object.fromEntries(
      parsed.error.issues.map((issue) => [issue.path.join('.') || 'form', issue.message]),
    ),
  };
}

export function parseChunkingSettingsDraft(value: unknown):
  | {
      success: true;
      data: S5ChunkingSettingsView;
    }
  | {
      success: false;
      errors: Record<string, string>;
    } {
  const parsed = s5ChunkingSettingsFormSchema.safeParse(value);
  if (parsed.success) return { success: true, data: parsed.data };
  return {
    success: false,
    errors: Object.fromEntries(
      parsed.error.issues.map((issue) => [issue.path.join('.') || 'form', issue.message]),
    ),
  };
}

export function buildImportParseConfig(config: S5ParseProviderConfigView): Record<string, unknown> {
  if (config.provider === 'liteparse') return config;
  if (config.provider === 'sangfor') {
    return {
      keepHeaderFooter: config.keepHeaderFooter ?? false,
      keepAppendix: config.keepAppendix ?? true,
      imageAnalysis: config.imageAnalysis ?? false,
      chartAnalysis: config.chartAnalysis ?? false,
      ...config,
    };
  }
  return config;
}

export function buildImportChunkingSettings(
  config: S5ChunkingSettingsView,
): Record<string, unknown> {
  return {
    trainingType: config.trainingType,
    chunkSettingMode: config.chunkSettingMode,
    ...(config.chunkTriggerType === undefined ? {} : { chunkTriggerType: config.chunkTriggerType }),
    ...(config.chunkTriggerMinSize === undefined
      ? {}
      : { chunkTriggerMinSize: config.chunkTriggerMinSize }),
    ...(config.chunkSplitMode === undefined ? {} : { chunkSplitMode: config.chunkSplitMode }),
    ...(config.paragraphChunkAIMode === undefined
      ? {}
      : { paragraphChunkAIMode: config.paragraphChunkAIMode }),
    ...(config.paragraphChunkDeep === undefined
      ? {}
      : { paragraphChunkDeep: config.paragraphChunkDeep }),
    ...(config.paragraphChunkMinSize === undefined
      ? {}
      : { paragraphChunkMinSize: config.paragraphChunkMinSize }),
    ...(config.chunkSize === undefined ? {} : { chunkSize: config.chunkSize }),
    ...(config.chunkSplitter === undefined ? {} : { chunkSplitter: config.chunkSplitter }),
    ...(config.overlap === undefined ? {} : { overlap: config.overlap }),
    ...(config.indexSize === undefined ? {} : { indexSize: config.indexSize }),
    ...(config.dataEnhanceCollectionName === undefined
      ? {}
      : { dataEnhanceCollectionName: config.dataEnhanceCollectionName }),
    ...(config.qaPrompt === undefined ? {} : { qaPrompt: config.qaPrompt }),
    ...(config.autoIndexes === undefined ? {} : { autoIndexes: config.autoIndexes }),
    ...(config.imageIndex === undefined ? {} : { imageIndex: config.imageIndex }),
    ...(config.indexPrefixTitle === undefined ? {} : { indexPrefixTitle: config.indexPrefixTitle }),
  };
}
