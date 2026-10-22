/**
 * CSV 解析：PapaParse 转 Markdown；表头缺失或重复时返回验证错误。
 * papaparse 无自带类型，采用带类型断言的动态 import（不新增依赖、不新增 .d.ts）。
 */
import { createRequire } from 'node:module';
import {
  decodeText,
  makeResult,
  parseError,
  parseFailedError,
  toMarkdownTable,
  type ParseHandler,
} from '../format-registry';

interface PapaParseError {
  code?: string;
}

interface PapaParseResult<T> {
  data: T[];
  errors: PapaParseError[];
}

interface PapaModule {
  parse<T>(
    input: string,
    config?: { skipEmptyLines?: boolean | 'greedy'; header?: boolean },
  ): PapaParseResult<T>;
}

const load = createRequire(import.meta.url);

export const parseCsv: ParseHandler = async (context) => {
  const requestId = context.request.fileRef;
  const Papa = load('papaparse') as unknown as PapaModule;
  const text = decodeText(context.bytes);
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy' });
  const rows = parsed.data as string[][];
  if (parsed.errors.length > 0) {
    throw parseFailedError('csv', parsed.errors[0]?.code ?? 'csv_parse_failed', requestId);
  }
  const header = (rows[0] ?? []).map((cell) => normalizeHeader(cell));
  const missingHeaders: string[] = [];
  for (const required of ['q', 'a']) if (!header.includes(required)) missingHeaders.push(required);
  const seen = new Set<string>();
  const duplicateHeaders: string[] = [];
  for (const name of header) {
    if (name.length === 0) continue;
    if (seen.has(name)) duplicateHeaders.push(name);
    else seen.add(name);
  }
  if (missingHeaders.length > 0 || duplicateHeaders.length > 0) {
    throw parseError('KNOWLEDGE_VALIDATION_FAILED', requestId, {
      missingHeaders,
      duplicateHeaders,
    });
  }
  const body = rows.slice(1).map((row) => header.map((_name, index) => String(row[index] ?? '')));
  return makeResult('csv', toMarkdownTable(header, body));
};

function normalizeHeader(value: string): string {
  return value
    .replace(/^\ufeff/, '')
    .trim()
    .toLowerCase();
}
