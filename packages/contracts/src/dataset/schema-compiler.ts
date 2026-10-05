import { z } from 'zod';
import {
  ErrorParamsSchema,
  JsonValueSchema,
  MetadataMapSchema,
  ModelReferenceSchema,
  ObjectIdSchema,
} from '../common/primitives';

export interface DtoSpec {
  name: string;
  fields: string;
  section: string;
}

type Resolver = (name: string) => z.ZodTypeAny | undefined;

const BUILTIN_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> = {
  string: z.string(),
  int: z.number().int(),
  number: z.number(),
  bool: z.boolean(),
  boolean: z.boolean(),
  enum: z.string(),
  binary: z.custom<Uint8Array>((value) => value instanceof Uint8Array),
  date: z.union([z.string().datetime({ offset: true }), z.date()]),
  Date: z.union([z.string().datetime({ offset: true }), z.date()]),
  ObjectId: ObjectIdSchema,
  JsonValue: JsonValueSchema,
  MetadataMap: MetadataMapSchema,
  ErrorParams: ErrorParamsSchema,
  ModelReference: ModelReferenceSchema,
};

export const DTO_BUILTIN_SCHEMAS = BUILTIN_SCHEMAS;

interface FieldSpec {
  name: string;
  optional: boolean;
  nullable: boolean;
  type: string;
  constraints: string;
  enumValues: string[] | null;
  defaultValue: unknown;
}

function normalizeFieldText(text: string): string {
  return text.replace(/（/g, '(').replace(/）/g, ')').replace(/，/g, ',').replace(/；/g, ';');
}

/** 按顶层分隔符切分；括号内的分隔符不参与切分。 */
export function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    if (char === separator && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

function parseField(rawField: string): FieldSpec | null {
  const trimmed = normalizeFieldText(rawField).trim();
  if (!trimmed) return null;
  const colon = trimmed.indexOf(':');
  if (colon === -1) return null;

  let name = trimmed.slice(0, colon).trim();
  let rest = trimmed.slice(colon + 1).trim();
  let optional = name.endsWith('?');
  if (optional) name = name.slice(0, -1).trim();

  let defaultValue: unknown;
  const defaultMatch = rest.match(/=([A-Za-z0-9_.-]+)/);
  if (defaultMatch?.[1] !== undefined) {
    const rawDefault = defaultMatch[1];
    defaultValue =
      rawDefault === 'true'
        ? true
        : rawDefault === 'false'
          ? false
          : Number.isNaN(Number(rawDefault))
            ? rawDefault
            : Number(rawDefault);
    optional = true;
    rest = rest.replace(defaultMatch[0], '');
  }

  const constraintParts = [...rest.matchAll(/\(([^()]*)\)/g)].map((match) => match[1] ?? '');
  constraintParts.push(...[...rest.matchAll(/[≤≥]\s*\d+/g)].map((match) => match[0]));
  const constraints = constraintParts.join(',');

  let enumValues: string[] | null = null;
  const enumMatch = rest.match(/enum\(([^)]*)\)/);
  if (enumMatch?.[1] !== undefined) {
    enumValues = enumMatch[1]
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    while (
      enumValues.length > 0 &&
      ['required', 'optional', 'null'].includes(enumValues[enumValues.length - 1] ?? '')
    ) {
      enumValues.pop();
    }
    rest = rest.replace(enumMatch[0], '');
  }

  const typeMatch = rest.trim().match(/^([A-Za-z][A-Za-z0-9_.]*)(\[\])?/);
  const type = typeMatch
    ? `${typeMatch[1] ?? ''}${typeMatch[2] ?? ''}`
    : enumMatch
      ? 'enum'
      : rest.trim();
  if (/optional/.test(constraints)) optional = true;
  const nullable = /\|null\b/.test(rest) || /\bnull\b/.test(constraints);

  return { name, optional, nullable, type, constraints, enumValues, defaultValue };
}

function numericBounds(constraints: string): { min?: number; max?: number } {
  const bounds: { min?: number; max?: number } = {};
  const range = constraints.match(/(\d+)\s*-\s*(\d+)/);
  if (range?.[1] !== undefined && range[2] !== undefined) {
    bounds.min = Number(range[1]);
    bounds.max = Number(range[2]);
  }
  const min = constraints.match(/[≥>]=?\s*(\d+)/);
  const max = constraints.match(/[≤<]=?\s*(\d+)/);
  if (min?.[1] !== undefined) bounds.min = Number(min[1]);
  if (max?.[1] !== undefined) bounds.max = Number(max[1]);
  return bounds;
}

function compileField(
  field: FieldSpec,
  resolve: Resolver,
  registryNames: ReadonlySet<string>,
  owner: string,
  errors: string[],
): z.ZodTypeAny {
  const bounds = numericBounds(field.constraints);
  let schema: z.ZodTypeAny;

  if (field.enumValues !== null && field.enumValues.length > 0) {
    schema = z.enum(field.enumValues as [string, ...string[]]);
  } else if (field.type === 'enum') {
    // 设计文档中少量字段只写 enum 而未展开取值，骨架期按字符串占位。
    schema = z.string();
  } else if (field.type.endsWith('[]')) {
    const innerField: FieldSpec = { ...field, type: field.type.slice(0, -2), constraints: '' };
    let arraySchema = z.array(compileField(innerField, resolve, registryNames, owner, errors));
    if (bounds.min !== undefined) arraySchema = arraySchema.min(bounds.min);
    if (bounds.max !== undefined) arraySchema = arraySchema.max(bounds.max);
    schema = arraySchema;
  } else if (field.type === 'string') {
    let stringSchema = z.string();
    if (bounds.min !== undefined) stringSchema = stringSchema.min(bounds.min);
    if (bounds.max !== undefined) stringSchema = stringSchema.max(bounds.max);
    schema = stringSchema;
  } else if (field.type === 'int' || field.type === 'number') {
    let numberSchema = field.type === 'int' ? z.number().int() : z.number();
    if (bounds.min !== undefined) numberSchema = numberSchema.min(bounds.min);
    if (bounds.max !== undefined) numberSchema = numberSchema.max(bounds.max);
    schema = numberSchema;
  } else {
    const builtin = BUILTIN_SCHEMAS[field.type];
    if (builtin) {
      schema = builtin;
    } else if (registryNames.has(field.type)) {
      schema = z.lazy(() => resolve(field.type) ?? z.unknown());
    } else {
      errors.push(`${owner}.${field.name}: 未登记类型 "${field.type}"`);
      schema = z.unknown();
    }
  }

  if (field.defaultValue !== undefined) {
    schema = schema.default(field.defaultValue as never);
  }
  if (field.nullable) schema = schema.nullable();
  if (field.optional && field.defaultValue === undefined) schema = schema.optional();
  return schema;
}

function buildObjectSchema(
  spec: DtoSpec,
  resolve: Resolver,
  registryNames: ReadonlySet<string>,
  errors: string[],
): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const rawField of splitTopLevel(normalizeFieldText(spec.fields), ';')) {
    const field = parseField(rawField);
    if (!field) continue;
    if (Object.prototype.hasOwnProperty.call(shape, field.name)) {
      errors.push(`${spec.name}.${field.name}: 字段重复`);
      continue;
    }
    shape[field.name] = compileField(field, resolve, registryNames, spec.name, errors);
  }
  return z.object(shape);
}

export interface CompiledDtoRegistry {
  schemas: Record<string, z.ZodTypeAny>;
  errors: string[];
}

export function compileDtoRegistry(specs: readonly DtoSpec[]): CompiledDtoRegistry {
  const schemas: Record<string, z.ZodTypeAny> = { ...BUILTIN_SCHEMAS };
  const errors: string[] = [];
  const registryNames = new Set(specs.map((spec) => spec.name));
  const resolve: Resolver = (name) => schemas[name];

  for (const spec of specs) {
    if (spec.name === 'ApiResponse<T>') continue;
    if (Object.prototype.hasOwnProperty.call(BUILTIN_SCHEMAS, spec.name)) continue;
    schemas[spec.name] = buildObjectSchema(spec, resolve, registryNames, errors);
  }

  return { schemas, errors };
}
