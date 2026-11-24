'use client';

import { AddIcon, DeleteIcon } from '@chakra-ui/icons';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { productApi, productSession } from './api';
import { ProductAppShell } from './shell';
import type { ModelSettings } from './types';
import {
  ProductButton,
  ProductError,
  ProductField,
  ProductInput,
  ProductPage,
  ProductPageHeader,
  ProductSelect,
  ProductSkeleton,
  useProductToast,
} from './ui';

export function ModelSettingsPage() {
  const toast = useProductToast();
  const session = useQuery({ queryKey: ['kb-product', 'session'], queryFn: productSession });
  const settings = useQuery({
    queryKey: ['kb-product', 'model-settings'],
    queryFn: productApi.getModelSettings,
    enabled:
      session.data?.isWorkspaceOwner === true ||
      session.data?.scopes.includes('knowledge:admin') === true,
  });
  const [draft, setDraft] = useState<ModelSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);

  useEffect(() => {
    if (settings.data) setDraft(structuredClone(settings.data));
  }, [settings.data]);

  const authorized =
    session.data?.isWorkspaceOwner === true ||
    session.data?.scopes.includes('knowledge:admin') === true;

  const save = async () => {
    if (!draft || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await productApi.updateModelSettings({
        version: draft.version,
        models: draft.models,
        defaults: draft.defaults,
      });
      setDraft(updated);
      await settings.refetch();
      toast.success('模型配置已保存');
    } catch (error) {
      setSaveError(error);
    } finally {
      setSaving(false);
    }
  };

  const modelsOfType = (type: 'embedding' | 'llm') =>
    draft?.models.filter((model) => model.enabled && model.type === type) ?? [];
  const imageModels =
    draft?.models.filter(
      (model) =>
        model.enabled &&
        (model.type === 'vlm' || (model.type === 'llm' && model.capabilities.includes('vision'))),
    ) ?? [];

  return (
    <ProductAppShell title="模型配置">
      <ProductPage>
        <ProductPageHeader
          title="模型配置"
          description="配置工作区可用的模型画像、启用状态和知识库默认模型。API Key 由部署环境安全提供，不在此页面保存。"
          actions={
            authorized && draft ? (
              <>
                <ProductButton
                  onClick={() => settings.data && setDraft(structuredClone(settings.data))}
                  disabled={saving}
                >
                  放弃修改
                </ProductButton>
                <ProductButton tone="primary" busy={saving} onClick={() => void save()}>
                  保存
                </ProductButton>
              </>
            ) : null
          }
        />
        {session.isLoading || settings.isLoading ? <ProductSkeleton rows={4} /> : null}
        <ProductError error={session.error ?? settings.error} />
        <ProductError error={saveError} />
        {!session.isLoading && !authorized ? (
          <div className="kb2-error-panel" role="alert">
            只有工作区所有者或知识库管理员可以修改模型配置。
          </div>
        ) : null}
        {draft && authorized ? (
          <>
            <section className="kb2-settings-section" aria-label="配置状态">
              <div className="kb2-settings-section__body">
                <dl className="kb2-folder-panel__meta">
                  <div>
                    <dt>配置来源</dt>
                    <dd>{draft.source === 'database' ? '平台数据库' : '部署环境'}</dd>
                  </div>
                  <div>
                    <dt>配置版本</dt>
                    <dd>{draft.version}</dd>
                  </div>
                  <div>
                    <dt>模型数量</dt>
                    <dd>{draft.models.length}</dd>
                  </div>
                </dl>
              </div>
            </section>
            <section className="kb2-settings-section" aria-label="默认模型">
              <h3>知识库默认模型</h3>
              <div className="kb2-settings-section__body kb2-form-stack">
                {(
                  [
                    ['embedding', '默认索引模型', modelsOfType('embedding')],
                    ['textLLM', '默认文本理解模型', modelsOfType('llm')],
                    ['imageLLM', '默认图片理解模型', imageModels],
                  ] as const
                ).map(([key, label, choices]) => (
                  <ProductField label={label} key={key}>
                    <ProductSelect
                      aria-label={label}
                      value={draft.defaults[key] ?? ''}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          defaults: {
                            ...draft.defaults,
                            [key]: event.target.value || null,
                          },
                        })
                      }
                    >
                      <option value="">不设置</option>
                      {choices.map((model) => (
                        <option key={model.modelId} value={model.modelId}>
                          {model.provider} · {model.displayName}
                        </option>
                      ))}
                    </ProductSelect>
                  </ProductField>
                ))}
              </div>
            </section>
            <details className="kb2-settings-section" open>
              <summary>
                <span>目录模型</span>
                <span>{draft.models.length} 项</span>
              </summary>
              <div className="kb2-settings-section__body kb2-form-stack">
                {draft.models.map((model, index) => (
                  <div className="kb2-model-setting-row" key={`${model.modelId}-${index}`}>
                    <ProductField label="模型 ID">
                      <ProductInput
                        value={model.modelId}
                        onChange={(event) => {
                          const models = [...draft.models];
                          models[index] = { ...model, modelId: event.target.value };
                          setDraft({ ...draft, models });
                        }}
                      />
                    </ProductField>
                    <ProductField label="显示名称">
                      <ProductInput
                        value={model.displayName}
                        onChange={(event) => {
                          const models = [...draft.models];
                          models[index] = { ...model, displayName: event.target.value };
                          setDraft({ ...draft, models });
                        }}
                      />
                    </ProductField>
                    <ProductField label="厂商">
                      <ProductInput
                        value={model.provider}
                        onChange={(event) => {
                          const models = [...draft.models];
                          models[index] = { ...model, provider: event.target.value };
                          setDraft({ ...draft, models });
                        }}
                      />
                    </ProductField>
                    <ProductField label="类型">
                      <ProductSelect
                        value={model.type}
                        onChange={(event) => {
                          const models = [...draft.models];
                          models[index] = {
                            ...model,
                            type: event.target.value as typeof model.type,
                          };
                          setDraft({ ...draft, models });
                        }}
                      >
                        {['llm', 'embedding', 'rerank', 'vlm', 'stt', 'tts'].map((type) => (
                          <option key={type} value={type}>
                            {type}
                          </option>
                        ))}
                      </ProductSelect>
                    </ProductField>
                    <ProductField label="能力（逗号分隔）">
                      <ProductInput
                        value={model.capabilities.join(',')}
                        onChange={(event) => {
                          const models = [...draft.models];
                          models[index] = {
                            ...model,
                            capabilities: event.target.value
                              .split(',')
                              .map((item) => item.trim())
                              .filter(Boolean),
                          };
                          setDraft({ ...draft, models });
                        }}
                      />
                    </ProductField>
                    <ProductField label="标签（逗号分隔）">
                      <ProductInput
                        value={model.tags.join(',')}
                        onChange={(event) => {
                          const models = [...draft.models];
                          models[index] = {
                            ...model,
                            tags: event.target.value
                              .split(',')
                              .map((item) => item.trim())
                              .filter(Boolean),
                          };
                          setDraft({ ...draft, models });
                        }}
                      />
                    </ProductField>
                    {model.type === 'embedding' ? (
                      <ProductField label="向量维度">
                        <ProductSelect
                          value={String(model.dimension ?? '')}
                          onChange={(event) => {
                            const models = [...draft.models];
                            models[index] = {
                              ...model,
                              dimension: event.target.value
                                ? (Number(event.target.value) as 768 | 1024 | 1536 | 3072)
                                : null,
                            };
                            setDraft({ ...draft, models });
                          }}
                        >
                          <option value="">请选择</option>
                          {[768, 1024, 1536, 3072].map((dimension) => (
                            <option key={dimension} value={dimension}>
                              {dimension}
                            </option>
                          ))}
                        </ProductSelect>
                      </ProductField>
                    ) : null}
                    <label className="kb2-check-row">
                      <input
                        type="checkbox"
                        checked={model.enabled}
                        onChange={(event) => {
                          const models = [...draft.models];
                          models[index] = { ...model, enabled: event.target.checked };
                          setDraft({ ...draft, models });
                        }}
                      />
                      启用
                    </label>
                    <ProductButton
                      tone="danger"
                      size="sm"
                      onClick={() =>
                        setDraft({
                          ...draft,
                          models: draft.models.filter((_, itemIndex) => itemIndex !== index),
                        })
                      }
                    >
                      <DeleteIcon /> 删除
                    </ProductButton>
                  </div>
                ))}
                <ProductButton
                  onClick={() =>
                    setDraft({
                      ...draft,
                      models: [
                        ...draft.models,
                        {
                          modelId: '',
                          displayName: '',
                          provider: 'Other',
                          type: 'llm',
                          capabilities: ['chat'],
                          tags: [],
                          enabled: true,
                          dimension: null,
                        },
                      ],
                    })
                  }
                >
                  <AddIcon /> 添加模型
                </ProductButton>
              </div>
            </details>
          </>
        ) : null}
      </ProductPage>
    </ProductAppShell>
  );
}
