import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { ApiErrorException, createApiError } from '@kb/contracts';
import type { ObjectRef, RequestContext } from '@kb/service';
import { objectKeyHash } from '@kb/storage';
import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { createRuntimeObjectStorePort } from '../../../../../runtime/object-store-adapter';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

interface PresignUploadBody {
  datasetId: string;
  filename: string;
  size: number;
  mime: string;
}

export interface UploadTokenPayload {
  kind: 'upload' | 'file';
  teamId: string;
  datasetId: string;
  bucket: string;
  key: string;
  uploadId: string;
  expiresAt: number;
}

export interface ParsedMultipartForm {
  fields: Record<string, string>;
  files: Record<string, { filename: string; contentType: string; content: Uint8Array }>;
}

export const UPLOAD_PART_PATH = '/api/core/dataset/file/uploadPart';
export const UPLOAD_TOKEN_TTL_MS = 15 * 60 * 1000;
export const FILE_REF_TTL_MS = 24 * 60 * 60 * 1000;

// 进程内 HMAC 密钥：方案已声明多实例无状态上传为已知风险（Plan §12.3）。
// Next dev/生产打包可能让同一模块在不同路由中各有一份实例；放 globalThis 保证进程内一致。
const globalStore = globalThis as typeof globalThis & { __kbUploadTokenSecret?: Buffer };
const TOKEN_SECRET = (globalStore.__kbUploadTokenSecret ??= randomBytes(32));

function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function signatureOf(body: string): string {
  return createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
}

/** 不透明上传/文件 token：base64url(payload).base64url(HMAC)；正文不含明文 dataset 路径。 */
export function signUploadToken(payload: UploadTokenPayload): string {
  const body = b64url(JSON.stringify(payload));
  return body + '.' + signatureOf(body);
}

function scopeForbidden(context: RequestContext): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code: 501061,
      requestId: context.requestId,
      params: { fileId: '', datasetId: '' },
    }),
  );
}

/** 校验签名、团队归属与过期时间；篡改/跨团队 501061，过期 501011。 */
export function verifyUploadToken(token: unknown, context: RequestContext): UploadTokenPayload {
  if (typeof token !== 'string' || token.length === 0) throw scopeForbidden(context);
  const dot = token.indexOf('.');
  if (dot <= 0) throw scopeForbidden(context);
  const body = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  const expected = signatureOf(body);
  const providedBuf = Buffer.from(provided, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
    throw scopeForbidden(context);
  }
  let payload: UploadTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as UploadTokenPayload;
  } catch {
    throw scopeForbidden(context);
  }
  if (payload.teamId !== context.tenant.teamId) throw scopeForbidden(context);
  if (typeof payload.expiresAt !== 'number' || payload.expiresAt <= Date.now()) {
    throw new ApiErrorException(
      createApiError({
        code: 501011,
        requestId: context.requestId,
        params: {
          keyHash: objectKeyHash(typeof payload.key === 'string' ? payload.key : ''),
          expiredAt: new Date(payload.expiresAt ?? 0).toISOString(),
        },
      }),
    );
  }
  return payload;
}

export function objectRefOf(payload: UploadTokenPayload): ObjectRef {
  return { bucket: payload.bucket, key: payload.key };
}

function headerOf(request: NextApiRequest, name: string): string | undefined {
  const raw = request.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** 原始字节归一：不按 base64 解码；字符串按 latin1 还原原始 multipart 字节。 */
export function toRawBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return Buffer.from(value, 'latin1');
  return new Uint8Array(0);
}

/**
 * 读取原始请求体：兼容真实 Readable 流（bodyParser:false）、Buffer/Uint8Array、
 * 原始字符串与测试注入的已解析对象。
 */
export async function readRequestBody(request: NextApiRequest): Promise<Buffer> {
  const body = request.body as unknown;
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === 'string') return Buffer.from(body, 'latin1');
  if (body !== undefined && body !== null) return Buffer.from(JSON.stringify(body), 'utf8');
  const stream = request as unknown as {
    on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  };
  if (typeof stream.on !== 'function') return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on?.('data', (chunk: unknown) => chunks.push(Buffer.from(toRawBytes(chunk))));
    stream.on?.('end', () => resolve());
    stream.on?.('error', (error: unknown) => reject(error));
  });
  return Buffer.concat(chunks);
}

/** 已是解析后的对象（测试或上层中间件）时按字段/文件归类。 */
function normalizeParsedBody(body: Record<string, unknown>): ParsedMultipartForm {
  const form: ParsedMultipartForm = { fields: {}, files: {} };
  for (const [key, value] of Object.entries(body)) {
    if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
      form.files[key] = {
        filename: '',
        contentType: 'application/octet-stream',
        content: toRawBytes(value),
      };
      continue;
    }
    const nested = recordOf(value);
    if (nested && (nested.content instanceof Uint8Array || Buffer.isBuffer(nested.content))) {
      form.files[key] = {
        filename: typeof nested.filename === 'string' ? nested.filename : '',
        contentType:
          typeof nested.contentType === 'string' ? nested.contentType : 'application/octet-stream',
        content: toRawBytes(nested.content),
      };
      continue;
    }
    if (value !== undefined && value !== null) form.fields[key] = String(value);
  }
  return form;
}

function parseMultipart(bytes: Uint8Array, boundary: string): ParsedMultipartForm {
  const form: ParsedMultipartForm = { fields: {}, files: {} };
  const delimiter = Buffer.from('--' + boundary);
  const buffer = Buffer.from(bytes);
  let cursor = buffer.indexOf(delimiter);
  while (cursor !== -1) {
    const start = cursor + delimiter.length;
    const next = buffer.indexOf(delimiter, start);
    if (next === -1) break;
    let part = buffer.subarray(start, next);
    // 去掉分隔符后的 CRLF 与结尾 CRLF
    if (part.subarray(0, 2).toString('latin1') === '\r\n') part = part.subarray(2);
    if (part.subarray(-2).toString('latin1') === '\r\n') part = part.subarray(0, -2);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headerText = part.subarray(0, headerEnd).toString('utf8');
      const content = part.subarray(headerEnd + 4);
      const nameMatch = /name="([^"]*)"/i.exec(headerText);
      const filenameMatch = /filename="([^"]*)"/i.exec(headerText);
      const typeMatch = /content-type:\s*([^\r\n]+)/i.exec(headerText);
      const name = nameMatch?.[1];
      if (name) {
        if (filenameMatch) {
          form.files[name] = {
            filename: filenameMatch[1] ?? '',
            contentType: typeMatch?.[1]?.trim() ?? 'application/octet-stream',
            content: new Uint8Array(content),
          };
        } else {
          form.fields[name] = content.toString('utf8');
        }
      }
    }
    cursor = next;
  }
  return form;
}

/** 读取 multipart 表单：支持已解析对象与真实 multipart/form-data 字节流。 */
export async function readMultipartForm(request: NextApiRequest): Promise<ParsedMultipartForm> {
  const body = request.body as unknown;
  const parsed = recordOf(body);
  if (parsed && !(body instanceof Uint8Array) && !Buffer.isBuffer(body)) {
    return normalizeParsedBody(parsed);
  }
  const contentType = headerOf(request, 'content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    return { fields: {}, files: {} };
  }
  const boundaryMatch = /boundary="?([^";]+)"?/i.exec(contentType);
  if (!boundaryMatch) return { fields: {}, files: {} };
  const bytes = await readRequestBody(request);
  return parseMultipart(bytes, boundaryMatch[1] ?? '');
}

/**
 * 统一 body 解析：JSON 对象直接返回；multipart 原始字节走 readMultipartForm；
 * 其他原始流尝试按 JSON 解析。供 complete/abort 等路由共享同一可靠路径。
 */
export async function resolveBodyObject(request: NextApiRequest): Promise<Record<string, unknown>> {
  const body = request.body as unknown;
  const parsed = recordOf(body);
  if (parsed && !(body instanceof Uint8Array) && !Buffer.isBuffer(body)) return parsed;
  const contentType = (headerOf(request, 'content-type') ?? '').toLowerCase();
  if (contentType.startsWith('multipart/form-data')) {
    const form = await readMultipartForm(request);
    return { ...form.fields };
  }
  const raw = await readRequestBody(request);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function sanitizeFilename(filename: string): string {
  const cleaned = [...filename]
    .filter((char) => (char.codePointAt(0) ?? 0) > 31)
    .join('')
    .replace(/[\\/]/g, '_')
    .slice(0, 255);
  return cleaned || 'upload';
}

function extensionOf(filename: string): string {
  const match = /(\.[A-Za-z0-9]{1,12})$/.exec(filename);
  return match?.[1] ?? '';
}

function runtimeBucket(runtime: Awaited<ReturnType<typeof getRuntime>>): string {
  return runtime.config.system.s3.bucket;
}

/** API-FILE-001 POST /api/core/dataset/file/presignUpload */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<PresignUploadBody>('PresignUploadBody', request.body);
    const options = { timeoutMs: 15_000 };
    const objectStore = createRuntimeObjectStorePort(runtime.clients.objectStore);
    const key = `dataset/${body.datasetId}/uploads/${randomUUID()}${extensionOf(sanitizeFilename(body.filename))}`;
    const prepared = await objectStore.prepareMultipart(
      {
        ref: { bucket: runtimeBucket(runtime), key },
        parts: 1,
        options,
        datasetId: body.datasetId,
      },
      context,
    );
    const expiresAt = Date.now() + UPLOAD_TOKEN_TTL_MS;
    const fileId = signUploadToken({
      kind: 'upload',
      teamId: context.tenant.teamId,
      datasetId: body.datasetId,
      bucket: prepared.bucket,
      key: prepared.key,
      uploadId: prepared.multipartUploadId ?? '',
      expiresAt,
    });
    response.status(200).json(
      successResponse(
        {
          uploadUrl: UPLOAD_PART_PATH,
          fileId,
          expiresAt: new Date(expiresAt).toISOString(),
        },
        requestId,
      ),
    );
  },
  { validationErrorCode: 501071 },
);
