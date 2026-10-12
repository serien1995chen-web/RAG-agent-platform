/**
 * P4-04 file 来源 Provider（设计 8.1.1 / 9.4）。
 * 经 ObjectStorePort.get 取字节，按扩展名/MIME 分派 @kb/parse 解析器。
 * 解析器由调用方注入（workspace 依赖假设 A1：@kb/service 未声明 @kb/parse，故不在本包内新建依赖）。
 * 未声明依赖段；无扩展名返回 501035。
 */
import type { DocumentParseContext, ParseResult } from '@kb/parse';
import type {
  DatasetSourceProvider,
  ObjectStorePort,
  SourceReadRequest,
  SourceReadResult,
} from '../../../../ports/capabilities';
import type { ObjectRef, RequestContext } from '../../../../ports/types';
import { sourceError } from './link-provider';

export interface FileParserLike {
  parse(request: DocumentParseContext): Promise<ParseResult>;
}

export interface FileSourceProviderDeps {
  objectStore: ObjectStorePort;
  parser: FileParserLike;
  resolveBucket?: (request: SourceReadRequest) => string;
}

const UNSUPPORTED_CONTENT = 501035;
const PARSE_FAILED = 501057;

function extensionOf(sourceRef: string): string {
  const clean = sourceRef.split('?')[0] ?? sourceRef;
  const dot = clean.lastIndexOf('.');
  return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : '';
}

export function createFileSourceProvider(deps: FileSourceProviderDeps): DatasetSourceProvider {
  const read = async (
    request: SourceReadRequest,
    context: RequestContext,
  ): Promise<SourceReadResult> => {
    const ref: ObjectRef = {
      bucket: deps.resolveBucket ? deps.resolveBucket(request) : 'kb-source',
      key: request.sourceRef,
    };
    const stored = await deps.objectStore.get(
      { ref, options: request.options, datasetId: request.datasetId },
      context,
    );
    const extension = extensionOf(request.sourceRef);
    if (extension.length === 0) {
      throw sourceError(UNSUPPORTED_CONTENT, context.requestId, {
        contentType: 'unknown',
        urlHash: '',
      });
    }
    const parseContext: DocumentParseContext = {
      teamId: context.tenant.teamId,
      datasetId: request.datasetId,
      fileRef: request.sourceRef,
      extension,
      timeoutMs: request.options.timeoutMs,
      bytes: stored.body,
    };
    try {
      const parsed = await deps.parser.parse(parseContext);
      return {
        rawText: parsed.rawText,
        contentHash: parsed.contentHash,
        fileRef: request.sourceRef,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'ApiErrorException') throw error;
      throw sourceError(PARSE_FAILED, context.requestId, {
        extension,
        reason: 'file_parse_failed',
      });
    }
  };

  return { read, preview: read };
}
