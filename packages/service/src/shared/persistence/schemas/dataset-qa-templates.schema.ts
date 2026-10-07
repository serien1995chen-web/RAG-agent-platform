import { Schema, type Types } from 'mongoose';
import { defineIndex } from '../define-index';

/** 设计文档 9.9.1 dataset_qa_templates 字段字典（全局或团队自定义 QA 模板）。 */
export interface DatasetQaTemplateDoc {
  templateId: string;
  version: number;
  locale: string;
  contentHash: string;
  status: string;
  teamId: Types.ObjectId | null;
  createTime: Date;
}

export const DatasetQaTemplateSchema = new Schema<DatasetQaTemplateDoc>(
  {
    templateId: { type: String, required: true },
    version: { type: Number, required: true },
    locale: { type: String, required: true },
    contentHash: { type: String, required: true },
    status: { type: String, required: true },
    // 全局系统模板 teamId 为 null；自定义模板必须归属团队。
    teamId: { type: Schema.Types.ObjectId, default: null },
    createTime: { type: Date, default: () => new Date(), required: true },
  },
  { collection: 'dataset_qa_templates', versionKey: false },
);

defineIndex(DatasetQaTemplateSchema, {
  name: 'ds_dataset_qa_templates_template_version_locale_unique',
  key: { templateId: 1, version: 1, locale: 1 },
  options: { unique: true },
});
