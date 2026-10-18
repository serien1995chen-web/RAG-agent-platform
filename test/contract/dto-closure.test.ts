import { describe, expect, it } from 'vitest';
import {
  DTO_SCHEMA_ERRORS,
  DTO_SPECS,
  ROUTE_REGISTRY,
  dtoRegistry,
  getDtoSchema,
  missingDtoReferences,
  resolveDtoExpression,
} from '../../packages/contracts/src/index';

/**
 * DTO 闭包四件套（设计 12.8.1/12.8.2/19.4.4，任务 P8-01-S05）：
 * TEST-API-DTO-CLOSURE-001 / TEST-API-REQUIRED-001 / TEST-API-NESTED-001 /
 * TEST-API-ROUTE-REF-001。
 */

/** schema-compiler 内置标量/值对象名（非注册表 DTO，但可解析）。 */
const BUILTIN_TYPE_NAMES = new Set([
  'string',
  'int',
  'number',
  'bool',
  'boolean',
  'enum',
  'binary',
  'date',
  'Date',
  'ObjectId',
  'JsonValue',
  'MetadataMap',
  'ErrorParams',
  'ModelReference',
  'T',
]);

function nestedTypeNames(fields: string): string[] {
  return [...fields.matchAll(/:\s*([A-Za-z][A-Za-z0-9_]*)/g)].map((match) => match[1] ?? '');
}

describe('DTO 闭包四件套（ACC-API-009 / ACC-API-010）', () => {
  it('TEST-API-DTO-CLOSURE-001 route→DTO 闭包：DTO_SCHEMA_ERRORS 与缺失引用均为空', () => {
    expect(DTO_SCHEMA_ERRORS).toEqual([]);
    expect(missingDtoReferences()).toEqual([]);
  });

  it('TEST-API-REQUIRED-001 requiredness 可解析：199 个 DTO，默认值与必填可判定', () => {
    expect(DTO_SPECS).toHaveLength(199);
    expect(dtoRegistry['Pagination']!.parse({})).toEqual({
      page: 1,
      limit: 20,
      sortOrder: 'desc',
    });
    expect(dtoRegistry['Pagination']!.safeParse({ limit: 101 }).success).toBe(false);
    expect(dtoRegistry['ApiError']!.safeParse({ code: 501001 }).success).toBe(false);
    expect(dtoRegistry['DatasetCreateBody']!.safeParse({ type: 'dataset' }).success).toBe(false);
  });

  it('小数区间可解析：ChunkPolicy.overlapRatio 0-0.9 不再被截断为 0-0', () => {
    const policy = {
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
    expect(dtoRegistry['ChunkPolicy']!.safeParse(policy).success).toBe(true);
    expect(dtoRegistry['ChunkPolicy']!.safeParse({ ...policy, overlapRatio: 0.95 }).success).toBe(
      false,
    );
  });

  it('TEST-API-NESTED-001 嵌套 Schema 具名：嵌套引用全部可解析且无匿名对象', () => {
    const unresolved = DTO_SPECS.flatMap((spec) =>
      nestedTypeNames(spec.fields)
        .filter((name) => !getDtoSchema(name) && !BUILTIN_TYPE_NAMES.has(name))
        .map((name) => `${spec.name}: ${name}`),
    );
    expect(unresolved).toEqual([]);

    expect(nestedTypeNames('models:ModelSelection(required)')).toEqual(['ModelSelection']);
    expect(nestedTypeNames('params:ErrorParams(required)')).toEqual(['ErrorParams']);
    expect(getDtoSchema('ModelSelection')).toBeDefined();
    expect(getDtoSchema('DatasetSummary')).toBeDefined();
    expect(getDtoSchema('ModelReference')).toBeDefined();

    const anonymous = DTO_SPECS.filter((spec) => /[{}]|\bobject\b/.test(spec.fields)).map(
      (spec) => spec.name,
    );
    expect(anonymous).toEqual([]);
  });

  it('TEST-API-ROUTE-REF-001 无孤立 route 引用：87 条 route 的 DTO 均可解析', () => {
    expect(ROUTE_REGISTRY).toHaveLength(87);
    const emptyExpression = ROUTE_REGISTRY.filter(
      (route) => route.requestDto.trim().length === 0 || route.responseDto.trim().length === 0,
    ).map((route) => route.routeId);
    expect(emptyExpression).toEqual([]);

    const unresolved = ROUTE_REGISTRY.flatMap((route) =>
      [route.requestDto, route.responseDto].flatMap((expression) =>
        resolveDtoExpression(expression)
          .filter((name) => !getDtoSchema(name))
          .map((name) => `${route.routeId}: ${name}`),
      ),
    );
    expect(unresolved).toEqual([]);
  });
});
