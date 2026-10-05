/**
 * 纯 JS 的 OpenAPI 3.1 组装器（无运行时依赖），供 scripts/*.mjs 与 CI 共用。
 * 数据源：errors/error-catalog.data.json、dataset/dto-registry.data.json、openapi/route-registry.data.json。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadContractData(repoRoot) {
  const base = join(repoRoot, 'packages', 'contracts', 'src');
  const read = (relativePath) => JSON.parse(readFileSync(join(base, relativePath), 'utf8'));
  return {
    routes: read(join('openapi', 'route-registry.data.json')).routes,
    dtos: read(join('dataset', 'dto-registry.data.json')).dtos,
    errors: read(join('errors', 'error-catalog.data.json')).errors,
  };
}

export const DERIVED_DTO_NAMES = ['ModelReference'];
export const BUILTIN_DTO_NAMES = [
  'ApiResponse<T>',
  'JsonValue',
  'MetadataMap',
  'ErrorParams',
  'ModelReference',
];

function normalizeFieldText(text) {
  return text.replace(/（/g, '(').replace(/）/g, ')').replace(/，/g, ',').replace(/；/g, ';');
}

function splitTopLevel(text, separator) {
  const parts = [];
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

function parseFields(fieldsText) {
  return splitTopLevel(normalizeFieldText(fieldsText), ';')
    .map((rawField) => {
      const trimmed = rawField.trim();
      const colon = trimmed.indexOf(':');
      if (colon === -1) return null;
      let name = trimmed.slice(0, colon).trim();
      let rest = trimmed.slice(colon + 1).trim();
      const optional = name.endsWith('?');
      if (optional) name = name.slice(0, -1).trim();
      const defaultMatch = rest.match(/=([A-Za-z0-9_.-]+)/);
      const defaultValue = defaultMatch?.[1];
      if (defaultMatch) rest = rest.replace(defaultMatch[0], '');
      let enumValues = null;
      const enumMatch = rest.match(/enum\(([^)]*)\)/);
      if (enumMatch?.[1] !== undefined) {
        enumValues = enumMatch[1]
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean);
        while (
          enumValues.length > 0 &&
          ['required', 'optional', 'null'].includes(enumValues[enumValues.length - 1])
        ) {
          enumValues.pop();
        }
        rest = rest.replace(enumMatch[0], '');
      }
      const typeMatch = rest.trim().match(/^([A-Za-z][A-Za-z0-9_.]*)(\[\])?/);
      const constraints = [...rest.matchAll(/\(([^()]*)\)/g)].map((match) => match[1]).join(',');
      return {
        name,
        type: typeMatch ? `${typeMatch[1]}${typeMatch[2] ?? ''}` : enumMatch ? 'enum' : rest.trim(),
        required: !optional && !/optional/.test(constraints) && defaultValue === undefined,
        nullable: /\|null\b/.test(rest) || /\bnull\b/.test(constraints),
        defaultValue,
        enumValues,
        restrictions:
          constraints.includes('≤') || constraints.includes('≥') || /\d-\d/.test(constraints)
            ? constraints
            : '',
      };
    })
    .filter(Boolean);
}

function jsonSchemaType(type, dtoNames) {
  if (type.endsWith('[]')) {
    return { type: 'array', items: jsonSchemaType(type.slice(0, -2), dtoNames) };
  }
  if (dtoNames.has(type)) return { $ref: `#/components/schemas/${type}` };
  switch (type) {
    case 'string':
    case 'enum':
      return { type: 'string' };
    case 'int':
      return { type: 'integer' };
    case 'number':
      return { type: 'number' };
    case 'bool':
    case 'boolean':
      return { type: 'boolean' };
    case 'binary':
      return { type: 'string', format: 'binary' };
    case 'date':
    case 'Date':
      return { type: 'string', format: 'date-time' };
    case 'ObjectId':
      return { type: 'string', pattern: '^[0-9a-fA-F]{24}$' };
    case 'JsonValue':
    case 'MetadataMap':
    case 'ErrorParams':
      return {};
    default:
      return {};
  }
}

function dtoJsonSchema(dto, dtoNames) {
  const properties = {};
  const required = [];
  for (const field of parseFields(dto.fields)) {
    const schema = jsonSchemaType(field.type, dtoNames);
    if (field.enumValues?.length) schema.enum = field.enumValues;
    if (field.defaultValue !== undefined) {
      schema.default =
        field.defaultValue === 'true'
          ? true
          : field.defaultValue === 'false'
            ? false
            : Number.isNaN(Number(field.defaultValue))
              ? field.defaultValue
              : Number(field.defaultValue);
    }
    if (field.nullable)
      schema.type = Array.isArray(schema.type)
        ? [...schema.type, 'null']
        : [schema.type ?? 'object', 'null'];
    if (field.restrictions) schema['x-kb-constraints'] = field.restrictions;
    properties[field.name] = schema;
    if (field.required) required.push(field.name);
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    'x-kb-dto': dto.name,
    'x-kb-field-spec': dto.fields,
  };
}

function responseRef(expression) {
  const unwrapped = expression
    .replace(/^ApiResponse<(.+)>$/s, '$1')
    .replace(/\[\]/g, '')
    .trim();
  return { $ref: `#/components/schemas/${unwrapped}` };
}

export function buildOpenApiDocument(repoRoot) {
  const { routes, dtos, errors } = loadContractData(repoRoot);
  const errorByCode = new Map(errors.map((error) => [error.code, error]));
  const dtoNames = new Set([...dtos.map((dto) => dto.name), ...DERIVED_DTO_NAMES, 'ApiError']);

  const schemas = {
    ApiError: {
      type: 'object',
      required: [
        'code',
        'statusText',
        'messageKey',
        'params',
        'message',
        'errorType',
        'retryable',
        'severity',
        'requestId',
      ],
      properties: {
        code: { type: 'integer', minimum: 501001, maximum: 501071 },
        statusText: { type: 'string' },
        messageKey: { type: 'string' },
        params: { type: 'object', additionalProperties: true },
        message: { type: 'string' },
        errorType: { type: 'string' },
        retryable: { type: 'string', enum: ['retryable', 'no-retry', 'manual'] },
        severity: { type: 'string', enum: ['warning', 'error', 'fatal'] },
        requestId: { type: 'string' },
        zodError: {},
      },
      'x-kb-error-catalog-size': errors.length,
    },
    ModelReference: {
      type: 'object',
      required: ['provider', 'model', 'dimension'],
      properties: {
        provider: { type: 'string' },
        model: { type: 'string' },
        dimension: { type: 'integer', enum: [1536] },
        capability: { type: 'string' },
      },
      'x-kb-derived-from': '7.3',
    },
  };

  for (const dto of dtos) {
    if (dto.name === 'ApiResponse<T>') continue;
    schemas[dto.name] = dtoJsonSchema(dto, dtoNames);
  }

  const paths = {};
  const tags = new Set();
  for (const route of routes) {
    tags.add(route.group);
    paths[route.path] ??= {};
    for (const method of route.method.split('/')) {
      const responses = {};
      if (route.implemented) {
        responses['200'] = {
          description: '骨架期最小实现（真实业务语义在后续阶段实现）',
          content: { 'application/json': { schema: responseRef(route.responseDto) } },
        };
      } else {
        responses['501'] = {
          description: '骨架期未实现（SKEL-ADR-007，code=501999）',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        };
      }
      for (const code of route.errorCodes) {
        const meta = errorByCode.get(code);
        const status = String(meta?.httpStatus ?? 500);
        responses[status] ??= {
          description: `${code} ${meta?.messageKey ?? 'unregistered'}`,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        };
      }
      paths[route.path][method.toLowerCase()] = {
        operationId: route.routeId,
        tags: [route.group],
        summary: route.source,
        'x-kb-route-id': route.routeId,
        'x-kb-request-dto': route.requestDto,
        'x-kb-response-dto': route.responseDto,
        'x-kb-error-codes': route.errorCodes,
        'x-kb-skeleton-implemented': route.implemented,
        responses,
      };
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'RAG-agent-platform Dataset API',
      version: '0.1.0',
      description:
        '由 @kb/contracts 的 12.8.2 DTO 注册表与 12.9 路由注册表生成的骨架版 OpenAPI 3.1 文档。',
    },
    servers: [],
    tags: [...tags].map((name) => ({ name })),
    paths,
    components: { schemas },
    'x-kb-contract': {
      generatedFrom: ['12.4', '12.4.1', '12.4.2', '12.8.2', '12.9'],
      routeCount: routes.length,
      dtoCount: dtos.length + DERIVED_DTO_NAMES.length,
      errorCount: errors.length,
      implementedRoutes: routes.filter((route) => route.implemented).map((route) => route.routeId),
      unimplementedStatusCode: 501,
      skeletonErrorCode: 501999,
    },
  };
}

export function buildClientTypes(repoRoot) {
  const { routes, dtos, errors } = loadContractData(repoRoot);
  const routeIds = routes.map((route) => `'${route.routeId}'`).join(' | ');
  const dtoNames = [...dtos.map((dto) => dto.name), ...DERIVED_DTO_NAMES]
    .map((name) => `'${name}'`)
    .join(' | ');
  const errorCodes = errors.map((error) => error.code).join(' | ');
  const methodMap = routes
    .map((route) => `  '${route.routeId}': '${route.method} ${route.path}';`)
    .join('\n');
  return `// 由 pnpm openapi:generate 生成，请勿手工修改。
export type RouteId = ${routeIds};
export type DtoName = ${dtoNames};
export type ErrorCode = ${errorCodes} | 501999;
export interface RouteMethodPathMap {
${methodMap}
}
`;
}

export function validateContractClosure(repoRoot) {
  const { routes, dtos, errors } = loadContractData(repoRoot);
  const problems = [];
  if (routes.length !== 87) problems.push(`路由数量应为 87，实际 ${routes.length}`);
  if (dtos.length !== 198) problems.push(`DTO 表应为 198 行，实际 ${dtos.length}`);
  if (errors.length !== 71) problems.push(`错误码应为 71 个，实际 ${errors.length}`);

  const dtoNames = new Set([...dtos.map((dto) => dto.name), ...BUILTIN_DTO_NAMES, 'ApiError']);
  const errorCodes = new Set(errors.map((error) => error.code));
  const seenIds = new Set();
  const seenOperations = new Set();
  for (const route of routes) {
    if (seenIds.has(route.routeId)) problems.push(`重复 Route ID ${route.routeId}`);
    seenIds.add(route.routeId);
    for (const dtoExpression of [route.requestDto, route.responseDto]) {
      const unwrapped = dtoExpression
        .replace(/^ApiResponse<(.+)>$/s, '$1')
        .replace(/\[\]/g, '')
        .trim();
      if (!dtoNames.has(unwrapped)) problems.push(`${route.routeId}: DTO 未登记 ${unwrapped}`);
    }
    for (const code of route.errorCodes) {
      if (!errorCodes.has(code)) problems.push(`${route.routeId}: 错误码未登记 ${code}`);
    }
    for (const method of route.method.split('/')) {
      const operation = `${method} ${route.path}`;
      if (seenOperations.has(operation)) problems.push(`重复 method+path ${operation}`);
      seenOperations.add(operation);
    }
    if (!route.implemented && route.errorCodes.length === 0 && route.routeId !== 'API-HEALTH-001') {
      problems.push(`${route.routeId}: 未实现路由必须声明错误码`);
    }
  }
  for (const error of errors) {
    if (!error.paramsSchema) problems.push(`${error.code}: 缺少 params Schema`);
  }
  return problems;
}
