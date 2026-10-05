import { Schema, type Types } from 'mongoose';
import { defineIndex } from '../define-index';

/** 设计文档 10.9 image_assets 字段字典。 */
export interface ImageAssetDoc {
  imageId: string;
  teamId: Types.ObjectId;
  datasetId: Types.ObjectId;
  collectionId: Types.ObjectId | null;
  objectKey: string;
  mimeType: string;
  size: number;
  ttlExpireAt: Date | null;
  persistent: boolean;
  state: 'temporary' | 'referenced' | 'deleting' | 'deleted' | 'failed';
  createTime: Date;
  updateTime: Date;
}

export const ImageAssetSchema = new Schema<ImageAssetDoc>(
  {
    imageId: { type: String, required: true },
    teamId: { type: Schema.Types.ObjectId, required: true },
    datasetId: { type: Schema.Types.ObjectId, required: true },
    collectionId: { type: Schema.Types.ObjectId, default: null },
    objectKey: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    ttlExpireAt: { type: Date, default: null },
    persistent: { type: Boolean, default: false, required: true },
    state: {
      type: String,
      enum: ['temporary', 'referenced', 'deleting', 'deleted', 'failed'],
      default: 'temporary',
      required: true,
    },
    createTime: { type: Date, default: () => new Date(), required: true },
    updateTime: { type: Date, default: () => new Date(), required: true },
  },
  { collection: 'image_assets', versionKey: false },
);

defineIndex(ImageAssetSchema, {
  name: 'ds_image_assets_team_image_unique',
  key: { teamId: 1, imageId: 1 },
  options: { unique: true },
});
defineIndex(ImageAssetSchema, {
  name: 'ds_image_assets_ttl_persistent_idx',
  key: { ttlExpireAt: 1, persistent: 1 },
});
defineIndex(ImageAssetSchema, {
  name: 'ds_image_assets_scope_idx',
  key: { teamId: 1, datasetId: 1, collectionId: 1 },
});
