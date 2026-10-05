import type { z } from 'zod';
import rawRegistry from './dto-registry.data.json';
import { DERIVED_DTO_SPECS } from './derived-dtos';
import { compileDtoRegistry, DTO_BUILTIN_SCHEMAS, type DtoSpec } from './schema-compiler';

export type { DtoSpec } from './schema-compiler';

/** 12.8.2 注册表 + 派生 DTO（ModelReference）。 */
export const DTO_SPECS: readonly DtoSpec[] = [
  ...(rawRegistry.dtos as unknown as DtoSpec[]),
  ...DERIVED_DTO_SPECS,
];

const compiled = compileDtoRegistry(DTO_SPECS);

/** 非空表示 DTO 闭包存在未登记类型或重复字段，契约测试必须失败。 */
export const DTO_SCHEMA_ERRORS: readonly string[] = compiled.errors;

export const dtoRegistry: Readonly<Record<string, z.ZodTypeAny>> = compiled.schemas;

export function getDtoSchema(name: string): z.ZodTypeAny | undefined {
  return compiled.schemas[name];
}

/** 去掉 ApiResponse<T> 包装与数组后缀，得到注册表中的基础 DTO 名。 */
export function unwrapDtoExpression(expression: string): string {
  let current = expression.trim();
  const generic = current.match(/^ApiResponse<(.+)>$/s);
  if (generic?.[1] !== undefined) current = generic[1].trim();
  return current.replace(/\[\]/g, '').split('|')[0]?.trim() ?? '';
}

export function resolveDtoExpression(expression: string): string[] {
  const unwrapped = expression.trim().replace(/^ApiResponse<(.+)>$/s, '$1');
  return unwrapped
    .split('|')
    .map((part) => part.replace(/\[\]/g, '').trim())
    .filter((part) => part.length > 0 && !['binary', 'T', 'JsonValue'].includes(part));
}

/** 路由注册表之外的 DTO 闭包检查：所有被引用类型都必须可解析。 */
export function missingDtoReferences(): string[] {
  const missing: string[] = [];
  for (const spec of DTO_SPECS) {
    if (spec.name === 'ApiResponse<T>') continue;
    for (const match of spec.fields.matchAll(/:\s*([A-Za-z][A-Za-z0-9_]*)/g)) {
      const name = match[1];
      if (name && !dtoRegistry[name] && !DTO_BUILTIN_SCHEMAS[name]) {
        missing.push(`${spec.name}: ${name}`);
      }
    }
  }
  return missing;
}
