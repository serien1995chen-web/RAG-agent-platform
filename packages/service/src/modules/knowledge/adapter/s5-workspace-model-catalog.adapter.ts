import type { Connection } from 'mongoose';
import { createKnowledgeError } from '@kb/contracts';
import { registerKnowledgeModels } from '../../../shared/persistence/schemas/knowledge-index';
import type {
  ModelCatalogItem,
  ModelCatalogMetadata,
  ModelCatalogPort,
  ModelDefaults,
  ModelSettingItem,
  ModelSettingsView,
} from '../application/s5-model-ports';
import { S5AiproxyCatalogAdapter } from './s5-aiproxy-catalog.adapter';
import type { S5HttpTransportPort } from './s5-aiproxy-http.adapter';
import type { S5AiproxyConfig } from '../../../shared/config/s5-aiproxy-config';

function profileEnv(
  models: readonly ModelSettingItem[],
  defaults: ModelDefaults,
  token: string,
): Record<string, string> {
  return {
    AIPROXY_API_TOKEN: token,
    S11_AIPROXY_MODEL_MAPPING_APPROVED: 'true',
    AIPROXY_MODEL_PROFILE_JSON: JSON.stringify({
      models: models.map((model) => ({
        id: model.modelId,
        displayName: model.displayName,
        provider: model.provider,
        type: model.type,
        capabilities: model.capabilities,
        tags: model.tags,
        enabled: model.enabled,
        ...(model.dimension === null ? {} : { dimension: model.dimension }),
        ...(model.limits ? { limits: model.limits } : {}),
      })),
      defaults: {
        ...(defaults.embedding ? { embedding: defaults.embedding } : {}),
        ...(defaults.textLLM ? { textLLM: defaults.textLLM } : {}),
        ...(defaults.imageLLM ? { imageLLM: defaults.imageLLM } : {}),
      },
    }),
  };
}

function validateDefaults(models: readonly ModelSettingItem[], defaults: ModelDefaults) {
  const byId = new Map(
    models.filter((model) => model.enabled).map((model) => [model.modelId, model]),
  );
  const checks: Array<{
    key: keyof ModelDefaults;
    type: 'embedding' | 'llm';
    capability?: string;
  }> = [
    { key: 'embedding', type: 'embedding', capability: 'text-embedding' },
    { key: 'textLLM', type: 'llm', capability: 'chat' },
    { key: 'imageLLM', type: 'llm', capability: 'vision' },
  ];
  for (const check of checks) {
    const id = defaults[check.key];
    if (!id) continue;
    const model = byId.get(id);
    const compatibleType =
      model?.type === check.type || (check.key === 'imageLLM' && model?.type === 'vlm');
    if (
      !model ||
      !compatibleType ||
      (check.capability && !model.capabilities.includes(check.capability))
    ) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        requestId: 'model-settings',
        traceId: 'model-settings',
        details: { field: `defaults.${check.key}`, reason: 'model_not_compatible' },
      });
    }
  }
}

function toSettingItem(item: ModelCatalogItem): ModelSettingItem {
  return {
    modelId: item.modelId,
    displayName: item.displayName,
    provider: item.provider ?? 'Other',
    type: item.type,
    capabilities: item.capabilities,
    tags: item.tags ?? [],
    enabled: item.authorized,
    dimension: item.dimension,
    ...(item.limits ? { limits: item.limits } : {}),
  };
}

/** Adds workspace persistence and runtime refresh around the stateless AIProxy catalog adapter. */
export class S5WorkspaceModelCatalogAdapter implements ModelCatalogPort {
  private readonly settingsModel: ReturnType<
    typeof registerKnowledgeModels
  >['KnowledgeModelSettings'];

  constructor(
    private readonly input: {
      connection: Connection;
      config: S5AiproxyConfig;
      transport: S5HttpTransportPort;
      env: Readonly<Record<string, string | undefined>>;
      token: string;
    },
  ) {
    this.settingsModel = registerKnowledgeModels(input.connection).KnowledgeModelSettings;
  }

  private environmentCatalog() {
    return new S5AiproxyCatalogAdapter({
      config: this.input.config,
      transport: this.input.transport,
      env: this.input.env,
    });
  }

  private databaseCatalog(models: readonly ModelSettingItem[], defaults: ModelDefaults) {
    return new S5AiproxyCatalogAdapter({
      config: this.input.config,
      transport: this.input.transport,
      env: profileEnv(models, defaults, this.input.token),
    });
  }

  async listModels(input: { workspaceId: string; requestId: string; traceId: string }) {
    const settings = await this.settingsModel
      .findOne({ workspaceId: input.workspaceId })
      .lean<{ models: ModelSettingItem[]; defaults: ModelDefaults }>();
    return settings
      ? this.databaseCatalog(settings.models, settings.defaults).listModels(input)
      : this.environmentCatalog().listModels(input);
  }

  async getMetadata(input: {
    workspaceId: string;
    requestId: string;
    traceId: string;
  }): Promise<ModelCatalogMetadata> {
    const settings = await this.settingsModel
      .findOne({ workspaceId: input.workspaceId })
      .lean<{ defaults: ModelDefaults }>();
    if (settings) return { source: 'database', defaults: settings.defaults };
    const metadata = await this.environmentCatalog().getMetadata();
    return { ...metadata, source: 'environment' };
  }

  async getSettings(input: {
    workspaceId: string;
    requestId: string;
    traceId: string;
  }): Promise<ModelSettingsView> {
    const settings = await this.settingsModel
      .findOne({ workspaceId: input.workspaceId })
      .lean<{ version: number; models: ModelSettingItem[]; defaults: ModelDefaults }>();
    if (settings) {
      return {
        version: settings.version,
        source: 'database',
        models: settings.models,
        defaults: settings.defaults,
      };
    }
    const [models, metadata] = await Promise.all([
      this.environmentCatalog()
        .listModels(input)
        .catch(() => []),
      this.environmentCatalog()
        .getMetadata()
        .catch(() => ({
          source: 'environment' as const,
          defaults: { embedding: null, textLLM: null, imageLLM: null },
        })),
    ]);
    return {
      version: 0,
      source: 'environment',
      models: models.map(toSettingItem),
      defaults: metadata.defaults,
    };
  }

  async updateSettings(
    input: { workspaceId: string; memberId: string; requestId: string; traceId: string },
    settings: Omit<ModelSettingsView, 'source'>,
  ): Promise<ModelSettingsView> {
    const ids = new Set(settings.models.map((model) => model.modelId));
    if (ids.size !== settings.models.length) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        requestId: input.requestId,
        traceId: input.traceId,
        details: { field: 'models', reason: 'model_id_must_be_unique' },
      });
    }
    validateDefaults(settings.models, settings.defaults);
    const existing = await this.settingsModel.findOne({ workspaceId: input.workspaceId }).lean<{
      version: number;
    }>();
    if ((existing?.version ?? 0) !== settings.version) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_CONFLICT',
        requestId: input.requestId,
        traceId: input.traceId,
        details: { field: 'version', expected: existing?.version ?? 0 },
      });
    }
    const document = await this.settingsModel
      .findOneAndUpdate(
        { workspaceId: input.workspaceId, version: settings.version },
        {
          $set: {
            models: settings.models,
            defaults: settings.defaults,
            updatedByMemberId: input.memberId,
          },
          $inc: { version: 1 },
          $setOnInsert: {
            workspaceId: input.workspaceId,
            createdByMemberId: input.memberId,
          },
        },
        { new: true, upsert: settings.version === 0 },
      )
      .lean<{ version: number; models: ModelSettingItem[]; defaults: ModelDefaults }>();
    if (!document) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_CONFLICT',
        requestId: input.requestId,
        traceId: input.traceId,
        details: { field: 'version' },
      });
    }
    return {
      version: document.version,
      source: 'database',
      models: document.models,
      defaults: document.defaults,
    };
  }
}
