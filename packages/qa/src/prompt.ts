/**
 * @kb/qa 自研默认模板 qa.default@1（设计文档 9.9.1 FIX-04）。
 * 不得引用来源项目文案；内容与 contentHash 登记在 knowledge_qa_templates。
 */
import { createHash } from 'node:crypto';
import type { QaRequest } from './parser';

export const DEFAULT_TEMPLATE_ID = 'qa.default' as const;
export const DEFAULT_TEMPLATE_VERSION = 1 as const;
export const DEFAULT_TEMPLATE_LOCALE = 'zh-CN' as const;

export const DEFAULT_QA_PROMPT = [
  '你是知识库问答对生成助手。',
  '请阅读给定文本，生成尽可能多的高质量问答对。',
  '严格按以下格式输出，每行一对，不要输出其它解释：',
  'Q1: 问题内容',
  'A1: 答案内容',
  'Q2: 问题内容',
  'A2: 答案内容',
  '问题与答案必须基于原文，不得编造原文之外的事实。',
].join('\n');

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
    allowPromptOverride: false,
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
  return `${basePrompt}\n\n----- 文本开始 -----\n${chunkText}\n----- 文本结束 -----`;
}
