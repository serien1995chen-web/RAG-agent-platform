/**
 * @kb/parse — 文档解析与 9 种格式矩阵（CR-FEATURE-04，设计文档 9.8.1）。
 * 未注册格式返回 KNOWLEDGE_UNSUPPORTED_CONTENT；备选解析器通过 Port 扩展。
 */
import type { objectStoreLike, ParseHandlerContext } from './format-registry';
import { parseFailedError, unsupportedFormatError } from './format-registry';
import type { ParseFormatRegistry } from './format-registry';
import { createParserRegistry } from './parsers/index';
import type { DocumentParserPort, ParseRequest, ParseResult } from './format-registry';

export const PACKAGE_NAME = '@kb/parse' as const;

export { contentHashOf, PARSE_FORMAT_MATRIX, resolveParseFormat } from './format-registry';
export type {
  DocumentParserPort,
  ParseFormatSpec,
  ParseRequest,
  ParseResult,
} from './format-registry';

export { createParserRegistry } from './parsers/index';
export { ParseFormatRegistry, normalizeExtension, normalizeMimeType } from './format-registry';
export type {
  ParseFormat,
  ParseFormatRegistration,
  ParseHandler,
  ParseHandlerContext,
  objectStoreLike,
} from './format-registry';
export {
  ArchiveSafetyError,
  ArchiveSafetyInspector,
  ArchiveSafetySourceError,
  DEFAULT_ARCHIVE_LIMITS,
  inspectArchiveBuffer,
  validateArchiveEntryPath,
} from './archive-safety';
export type {
  ArchiveContainer,
  ArchiveInspectionInput,
  ArchiveInspectionLimits,
  ArchiveInspectionResult,
  ArchiveRangeSource,
  ArchiveSafetyReason,
} from './archive-safety';
export { ConcurrencyLimiterError, createLimiter, mapWithConcurrency } from './concurrency';
export type { ConcurrencyLimiter, ConcurrencyLimiterOptions } from './concurrency';
export { IMPORT_TEMPLATE_LIMITS, parseImportTemplate } from './import-template';
export type {
  ImportTemplateDiagnostic,
  ImportTemplateResult,
  ImportTemplateRow,
  ParseImportTemplateInput,
} from './import-template';

/**
 * 解析所需上下文：兼容既有 DocumentParserPort.parse(request) 调用面。
 * bytes/objectStore/enhanceScannedPdf 由集成层（P4-04）注入，不改变 Port 形状。
 */
export interface DocumentParseContext extends ParseRequest {
  bytes?: Uint8Array;
  objectStore?: objectStoreLike;
  enhanceScannedPdf?: (bytes: Uint8Array, request: ParseRequest) => Promise<ParseResult>;
}

function toHandlerContext(request: ParseRequest): ParseHandlerContext | null {
  const context = request as DocumentParseContext;
  if (!(context.bytes instanceof Uint8Array)) return null;
  return {
    request,
    bytes: context.bytes,
    mimeType: request.mimeType,
    objectStore: context.objectStore,
    enhanceScannedPdf: context.enhanceScannedPdf,
  };
}

/**
 * 真实解析入口：按扩展名/MIME 分派到 9 类解析器之一。
 * 未登记格式或缺少字节上下文时稳定拒绝，绝不静默返回空文本。
 */
export function createDefaultDocumentParser(): DocumentParserPort {
  const registry: ParseFormatRegistry = createParserRegistry();
  return {
    async parse(request: ParseRequest): Promise<ParseResult> {
      const format = registry.resolve(request.extension, request.mimeType);
      if (!format) {
        throw unsupportedFormatError(request.extension, request.fileRef);
      }
      const registration = registry.get(format);
      if (!registration) {
        throw unsupportedFormatError(request.extension, request.fileRef);
      }
      const context = toHandlerContext(request);
      if (!context)
        throw parseFailedError(request.extension, 'parse_bytes_missing', request.fileRef);
      return registration.handler(context);
    },
  };
}
