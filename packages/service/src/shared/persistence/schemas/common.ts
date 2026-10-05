import { Schema } from 'mongoose';

/** 设计文档 9.8.1 的 ChunkPolicy 默认值。 */
export interface ChunkPolicyValue {
  mode: 'auto' | 'paragraph' | 'custom';
  chunkSize: number;
  minSize: number;
  maxSize: number;
  overlapRatio: number;
  paragraphDeep: number;
  customRegs: string[];
  lengthUnit: 'char' | 'token';
  forceSplit: boolean;
  maxChunks: number;
}

export const DEFAULT_CHUNK_POLICY: ChunkPolicyValue = {
  mode: 'auto',
  chunkSize: 1000,
  minSize: 100,
  maxSize: 8000,
  overlapRatio: 0.15,
  paragraphDeep: 5,
  customRegs: [],
  lengthUnit: 'token',
  forceSplit: true,
  maxChunks: 50000,
};

export const ChunkPolicySchema = new Schema<ChunkPolicyValue>(
  {
    mode: { type: String, enum: ['auto', 'paragraph', 'custom'], default: 'auto', required: true },
    chunkSize: { type: Number, default: 1000, required: true },
    minSize: { type: Number, default: 100, required: true },
    maxSize: { type: Number, default: 8000, required: true },
    overlapRatio: { type: Number, default: 0.15, required: true },
    paragraphDeep: { type: Number, default: 5, required: true },
    customRegs: { type: [String], default: [] },
    lengthUnit: { type: String, enum: ['char', 'token'], default: 'token', required: true },
    forceSplit: { type: Boolean, default: true, required: true },
    maxChunks: { type: Number, default: 50000, required: true },
  },
  { _id: false },
);

export interface SourceRefValue {
  type: string;
  fileId?: string | null;
  link?: string | null;
  apiConfigRef?: string | null;
  externalFileId?: string | null;
}

export const SourceRefSchema = new Schema<SourceRefValue>(
  {
    type: { type: String, required: true },
    fileId: { type: String, default: null },
    link: { type: String, default: null },
    apiConfigRef: { type: String, default: null },
    externalFileId: { type: String, default: null },
  },
  { _id: false },
);

export interface KnowledgeItemIndexValue {
  type: string;
  dataId?: string | null;
  text: string;
}

export const KnowledgeItemIndexSchema = new Schema<KnowledgeItemIndexValue>(
  {
    type: {
      type: String,
      enum: ['default', 'imageEmbedding', 'summary', 'question', 'image', 'custom'],
      default: 'custom',
      required: true,
    },
    dataId: { type: String, default: null },
    text: { type: String, required: true },
  },
  { _id: false },
);

export interface DataHistoryEntryValue {
  oldQuestion: string;
  oldAnswer: string;
  updatedAt: Date;
}

export const DataHistoryEntrySchema = new Schema<DataHistoryEntryValue>(
  {
    oldQuestion: { type: String, required: true },
    oldAnswer: { type: String, default: '', required: true },
    updatedAt: { type: Date, required: true },
  },
  { _id: false },
);
