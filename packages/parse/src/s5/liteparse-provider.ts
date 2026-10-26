import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  contentHashOf,
  makeResult,
  normalizeMimeType,
  parseError,
  type ParseHandler,
  type ParseHandlerContext,
  type ParsePage,
} from '../format-registry';
import { parsePdfWithPdfJs } from '../parsers/pdf';

export interface S5LiteParseConfig {
  provider: 'liteparse';
  ocrEnabled: false;
  maxPages: number;
  batchPages: number;
  fallbackPdfJsOnWasmLoadError: boolean;
  timeoutMs: number;
}

interface ConfigIssue {
  path: string;
  message: string;
}

function validateLiteParseConfig(value: unknown):
  | {
      success: true;
      data: S5LiteParseConfig;
    }
  | {
      success: false;
      issues: ConfigIssue[];
    } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { success: false, issues: [{ path: 'value', message: 'object required' }] };
  }
  const input = value as Record<string, unknown>;
  const defaults: S5LiteParseConfig = {
    provider: 'liteparse',
    ocrEnabled: false,
    maxPages: 100_000,
    batchPages: 100,
    fallbackPdfJsOnWasmLoadError: true,
    timeoutMs: 600_000,
  };
  const result: S5LiteParseConfig = {
    ...defaults,
    ...(typeof input.maxPages === 'number' ? { maxPages: input.maxPages } : {}),
    ...(typeof input.batchPages === 'number' ? { batchPages: input.batchPages } : {}),
    ...(typeof input.fallbackPdfJsOnWasmLoadError === 'boolean'
      ? { fallbackPdfJsOnWasmLoadError: input.fallbackPdfJsOnWasmLoadError }
      : {}),
    ...(typeof input.timeoutMs === 'number' ? { timeoutMs: input.timeoutMs } : {}),
  };
  const issues: ConfigIssue[] = [];
  if (input.provider !== undefined && input.provider !== 'liteparse') {
    issues.push({ path: 'provider', message: 'must be liteparse' });
  }
  if (input.ocrEnabled !== undefined && input.ocrEnabled !== false) {
    issues.push({ path: 'ocrEnabled', message: 'must be false' });
  }
  if (!Number.isInteger(result.maxPages) || result.maxPages < 1 || result.maxPages > 100_000) {
    issues.push({ path: 'maxPages', message: 'must be an integer from 1 to 100000' });
  }
  if (!Number.isInteger(result.batchPages) || result.batchPages < 1 || result.batchPages > 100) {
    issues.push({ path: 'batchPages', message: 'must be an integer from 1 to 100' });
  }
  if (
    !Number.isInteger(result.timeoutMs) ||
    result.timeoutMs < 1_000 ||
    result.timeoutMs > 600_000
  ) {
    issues.push({ path: 'timeoutMs', message: 'must be an integer from 1000 to 600000' });
  }
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(defaults, key)) {
      issues.push({ path: key, message: 'unknown field' });
    }
  }
  return issues.length === 0 ? { success: true, data: result } : { success: false, issues };
}

export const S5LiteParseConfigSchema = {
  safeParse: validateLiteParseConfig,
};

interface LiteParseLike {
  parse(data: Uint8Array): Promise<unknown>;
  free?(): void;
}

export interface LiteParseModuleLike {
  LiteParse: new (config: Record<string, unknown>) => LiteParseLike;
}

export type LiteParseLoader = () => Promise<LiteParseModuleLike>;

interface LiteParseResult {
  text: string;
  pages: Array<{ pageNum: number; text: string }>;
}

function parseLiteParseResult(value: unknown): LiteParseResult | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.text !== 'string' || !Array.isArray(record.pages)) return null;
  const pages: LiteParseResult['pages'] = [];
  for (const raw of record.pages) {
    if (typeof raw !== 'object' || raw === null) return null;
    const page = raw as Record<string, unknown>;
    if (
      !Number.isInteger(page.pageNum) ||
      (page.pageNum as number) < 1 ||
      typeof page.text !== 'string'
    ) {
      return null;
    }
    pages.push({ pageNum: page.pageNum as number, text: page.text });
  }
  return { text: record.text, pages };
}

const require = createRequire(import.meta.url);
let defaultModule: Promise<LiteParseModuleLike> | undefined;

async function loadDefaultLiteParse(): Promise<LiteParseModuleLike> {
  defaultModule ??= (async () => {
    const packageJson = require.resolve('@llamaindex/liteparse-wasm/package.json');
    const packageRoot = dirname(packageJson);
    const wasmPath = join(packageRoot, 'pkg', 'liteparse_wasm_bg.wasm');
    const module =
      (await import('@llamaindex/liteparse-wasm')) as unknown as LiteParseModuleLike & {
        default(input: { module_or_path: Uint8Array }): Promise<unknown>;
      };
    await module.default({ module_or_path: new Uint8Array(await readFile(wasmPath)) });
    return { LiteParse: module.LiteParse };
  })();
  return defaultModule;
}

export async function loadLiteParse(
  loader: LiteParseLoader = loadDefaultLiteParse,
): Promise<LiteParseModuleLike> {
  return loader();
}

function isMaxPagesError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /max.?pages|page.?limit|page count/i.test(message);
}

export async function parseWithLiteParse(
  context: ParseHandlerContext,
  options: {
    config?: Partial<S5LiteParseConfig>;
    loader?: LiteParseLoader;
  } = {},
) {
  const requestId = context.request.fileRef;
  if (context.bytes.byteLength === 0) {
    throw parseError('KNOWLEDGE_UNSUPPORTED_CONTENT', requestId, {
      format: 'pdf',
      reason: 'empty_input',
    });
  }
  const mime = normalizeMimeType(context.request.mimeType);
  if (mime !== undefined && mime !== 'application/pdf') {
    throw parseError('KNOWLEDGE_UNSUPPORTED_CONTENT', requestId, {
      format: 'pdf',
      reason: 'mime_mismatch',
    });
  }
  const parsedConfig = S5LiteParseConfigSchema.safeParse({
    provider: 'liteparse',
    ocrEnabled: false,
    ...options.config,
  });
  if (!parsedConfig.success) {
    throw parseError('KNOWLEDGE_VALIDATION_FAILED', requestId, {
      field: 'liteparseConfig',
      issues: parsedConfig.issues.map((issue) => ({
        path: issue.path,
        message: issue.message,
      })),
    });
  }
  const config = parsedConfig.data;
  let module: LiteParseModuleLike;
  try {
    module = await loadLiteParse(options.loader);
  } catch {
    if (!config.fallbackPdfJsOnWasmLoadError) {
      throw parseError('KNOWLEDGE_DEPENDENCY_UNAVAILABLE', requestId, {
        dependency: 'liteparse-wasm',
        reason: 'load_or_init_failed',
      });
    }
    const fallback = await parsePdfWithPdfJs(context);
    return {
      ...fallback,
      parserVersion: `pdfjs@4.10.38+liteparse@2.0.8`,
      diagnostics: [
        ...fallback.diagnostics,
        { severity: 'warning' as const, code: 'liteparse_load_fallback' },
      ],
    };
  }

  const parser = new module.LiteParse({
    ocrEnabled: false,
    outputFormat: 'json',
    maxPages: config.maxPages,
    quiet: true,
  });
  let parsed: LiteParseResult;
  try {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            parseError('KNOWLEDGE_DEPENDENCY_TIMEOUT', requestId, {
              dependency: 'liteparse-wasm',
              timeoutMs: config.timeoutMs,
            }),
          ),
        config.timeoutMs,
      );
    });
    const raw = await Promise.race([parser.parse(context.bytes), timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    const validated = parseLiteParseResult(raw);
    if (validated === null) {
      throw parseError('KNOWLEDGE_PROVIDER_CONTRACT_INVALID', requestId, {
        provider: 'liteparse',
        reason: 'response_schema_invalid',
      });
    }
    parsed = validated;
  } catch (error) {
    if (error instanceof Error && error.name === 'KnowledgeApiError') throw error;
    if (isMaxPagesError(error)) {
      throw parseError('KNOWLEDGE_PAGE_LIMIT', requestId, {
        maxPages: config.maxPages,
      });
    }
    throw parseError('KNOWLEDGE_UNSUPPORTED_CONTENT', requestId, {
      format: 'pdf',
      reason: /password|encrypt/i.test(String(error)) ? 'encrypted_pdf' : 'pdf_content_invalid',
    });
  } finally {
    parser.free?.();
  }
  const pages: ParsePage[] = parsed.pages
    .slice()
    .sort((left, right) => left.pageNum - right.pageNum)
    .map((page) => ({
      pageNumber: page.pageNum,
      text: page.text,
      assets: [],
    }));
  const rawText =
    parsed.text.length > 0 ? parsed.text : pages.map((page) => page.text).join('\n\n');
  const scanRequired = rawText.replace(/\s/g, '').length === 0;
  const configHash = contentHashOf(JSON.stringify(config));
  return makeResult('pdf', rawText, {
    pages,
    assets: [],
    diagnostics: scanRequired ? [{ severity: 'warning', code: 'pdf_text_layer_missing' }] : [],
    scanRequired,
    parserVersion: 'liteparse@2.0.8',
    configHash,
  });
}

export const parsePdfWithLiteParse: ParseHandler = async (context) => parseWithLiteParse(context);
