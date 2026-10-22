import { Schema } from 'mongoose';

export const knowledgeCommonFields = {
  workspaceId: { type: String, required: true, trim: true },
  knowledgeSpaceId: {
    type: Schema.Types.ObjectId,
    default: null,
  },
  version: { type: Number, required: true, min: 1, default: 1 },
  deletedAt: { type: Date, default: null },
  createdByMemberId: { type: String, required: true },
  updatedByMemberId: { type: String, required: true },
} as const;

export function knowledgeSchemaOptions(collection: string) {
  return {
    collection,
    timestamps: true,
    versionKey: false,
    minimize: false,
    strict: true,
  } as const;
}

export function normalizedName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

export const JsonObjectSchema = new Schema(
  {
    key: { type: String, required: true, maxlength: 128 },
    value: { type: Schema.Types.Mixed, required: true },
  },
  { _id: false },
);
