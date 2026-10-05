import { z } from 'zod';

/** ObjectId 统一以 24 位十六进制字符串传输（Mongo ObjectId 的 JSON 形态）。 */
export const ObjectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'ObjectId 必须是 24 位十六进制字符串');

export const IsoDateTimeSchema = z.union([z.string().datetime({ offset: true }), z.date()]);

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/** 设计文档 12.8.2 将 MetadataMap 定义为单一 key/value 对。 */
export const MetadataMapSchema = z.object({
  key: z.string().min(1).max(128),
  value: JsonValueSchema,
});

export const ErrorParamsSchema = z.object({
  path: z.string().max(512).optional(),
  reason: z.string().max(256).optional(),
  details: MetadataMapSchema.optional(),
});

/** 设计文档 7.3 / 6.1.10：在线模型维度固定为 1536。 */
export const ModelReferenceSchema = z.object({
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(128),
  dimension: z
    .number()
    .int()
    .refine((value) => value === 1536, '在线模型维度必须为 1536'),
  capability: z.string().min(1).max(64).optional(),
});

export type ModelReference = z.infer<typeof ModelReferenceSchema>;
