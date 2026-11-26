import { createHash } from 'node:crypto';
import { DEFAULT_QA_PROMPT, QA_FIXED_TEMPLATE } from '@kb/contracts';
import type { QaRequest } from './parser';

export { DEFAULT_QA_PROMPT, QA_FIXED_TEMPLATE };

export const DEFAULT_TEMPLATE_ID = 'qa.default' as const;
export const DEFAULT_TEMPLATE_VERSION = 1 as const;
export const DEFAULT_TEMPLATE_LOCALE = 'zh-CN' as const;

export const DEFAULT_QA_PROMPT_HASH = `sha256:${createHash('sha256')
  .update(DEFAULT_QA_PROMPT, 'utf8')
  .digest('hex')}`;

export interface QaTemplate {
  templateId: string;
  version: number;
  locale: string;
  contentHash: string;
  status: 'active' | 'deprecated' | 'disabled';
  /** 是否允许请求方用 qaPrompt 覆盖模板正文。 */
  allowPromptOverride?: boolean;
}

export interface QaTemplateRegistryPort {
  find(
    templateId: string,
    version: number,
    locale?: string,
  ): Promise<QaTemplate | null> | QaTemplate | null;
}

export function createDefaultTemplateRegistry(): QaTemplateRegistryPort {
  const template: QaTemplate = {
    templateId: DEFAULT_TEMPLATE_ID,
    version: DEFAULT_TEMPLATE_VERSION,
    locale: DEFAULT_TEMPLATE_LOCALE,
    contentHash: DEFAULT_QA_PROMPT_HASH,
    status: 'active',
    allowPromptOverride: true,
  };
  return {
    find: (templateId, version) =>
      templateId === template.templateId && version === template.version ? template : null,
  };
}

/** 解析实际使用的提示词：仅当模板允许覆盖时 qaPrompt 生效。 */
export function resolvePrompt(template: QaTemplate, request: QaRequest): string {
  if (template.allowPromptOverride && request.qaPrompt && request.qaPrompt.trim().length > 0) {
    return request.qaPrompt;
  }
  return DEFAULT_QA_PROMPT;
}

/** 组装给模型的完整提示词。 */
export function buildQaPrompt(basePrompt: string, chunkText: string): string {
  return `${basePrompt}\n${QA_FIXED_TEMPLATE.replaceAll('{{text}}', chunkText)}`;
}
