import { ApiErrorException, createApiError } from '@kb/contracts';

/**
 * 设计文档 12.8 的集合类型枚举（唯一真源）。
 * ISSUE-001：来源类型（text/image/…）必须在写入边界归一为这里的值，
 * 禁止让来源词汇直接流入持久化层。
 */
export const PERSISTED_COLLECTION_TYPES = [
  'folder',
  'virtual',
  'file',
  'link',
  'externalFile',
  'apiFile',
  'images',
] as const;

export type PersistedCollectionType = (typeof PERSISTED_COLLECTION_TYPES)[number];

/** 来源类型 → 持久化类型；未登记的来源在触库前以 501001 拒绝。 */
const SOURCE_TYPE_MAP: Readonly<Record<string, PersistedCollectionType>> = {
  text: 'file',
  image: 'images',
};

const PERSISTED_SET: ReadonlySet<string> = new Set(PERSISTED_COLLECTION_TYPES);

export function isPersistedCollectionType(value: string): value is PersistedCollectionType {
  return PERSISTED_SET.has(value);
}

/**
 * 归一入口。已登记来源类型映射到持久化词汇；非法值抛结构化错误，
 * 而不是让 Mongoose ValidationError 冒泡成 501998。
 */
export function toPersistedCollectionType(
  source: string,
  requestId = 'collection-type',
): PersistedCollectionType {
  if (isPersistedCollectionType(source)) return source;

  const mapped = SOURCE_TYPE_MAP[source];
  if (mapped !== undefined) return mapped;

  throw new ApiErrorException(
    createApiError({
      code: 501001,
      requestId,
      params: { type: source },
    }),
  );
}
