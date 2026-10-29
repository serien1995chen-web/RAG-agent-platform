import { Readable } from 'node:stream';
import { createKnowledgeError } from '@kb/contracts';
import type { NextApiRequest } from 'next';

export const SYNONYM_MULTIPART_MAX_BYTES = 11 * 1024 * 1024;
export const SYNONYM_FILE_MAX_BYTES = 10 * 1024 * 1024;

export interface S09SynonymMultipartBody {
  file: {
    name: string;
    mimeType: string;
    bytes: Uint8Array;
  };
  enabled?: boolean;
  expectedFileVersion?: number;
}

function validation(requestId: string, traceId: string, details: Record<string, unknown>) {
  return createKnowledgeError({
    code: 'KNOWLEDGE_VALIDATION_FAILED',
    requestId,
    traceId,
    details,
  });
}

function tooLarge(requestId: string, traceId: string, limitBytes: number) {
  return createKnowledgeError({
    code: 'KNOWLEDGE_PAYLOAD_TOO_LARGE',
    requestId,
    traceId,
    details: { field: 'file', limitBytes },
  });
}

async function readMultipartBytes(
  request: NextApiRequest,
  requestId: string,
  traceId: string,
): Promise<Buffer> {
  if (request.body instanceof Uint8Array) {
    const buffer = Buffer.from(request.body);
    if (buffer.byteLength > SYNONYM_MULTIPART_MAX_BYTES) {
      throw tooLarge(requestId, traceId, SYNONYM_MULTIPART_MAX_BYTES);
    }
    return buffer;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.byteLength;
    if (total > SYNONYM_MULTIPART_MAX_BYTES) {
      throw tooLarge(requestId, traceId, SYNONYM_MULTIPART_MAX_BYTES);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export async function resolveSynonymMultipart(
  request: NextApiRequest,
  requestId: string,
  traceId: string,
): Promise<S09SynonymMultipartBody> {
  const contentType = request.headers['content-type'];
  const headerValue = Array.isArray(contentType) ? contentType[0] : contentType;
  if (!headerValue?.toLowerCase().startsWith('multipart/form-data')) {
    throw validation(requestId, traceId, {
      header: 'Content-Type',
      reason: 'multipart_form_data_required',
    });
  }
  const bytes = await readMultipartBytes(request, requestId, traceId);
  let form: FormData;
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined) continue;
      headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    const webRequest = new Request('http://localhost/v1/knowledge/synonyms', {
      method: 'POST',
      headers,
      body: Readable.toWeb(Readable.from(bytes)) as ReadableStream<Uint8Array>,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    form = await webRequest.formData();
  } catch {
    throw validation(requestId, traceId, {
      field: 'body',
      reason: 'multipart_parse_failed',
    });
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    throw validation(requestId, traceId, { field: 'file', reason: 'binary_file_required' });
  }
  if (file.size > SYNONYM_FILE_MAX_BYTES) {
    throw tooLarge(requestId, traceId, SYNONYM_FILE_MAX_BYTES);
  }
  if (file.size === 0) {
    throw validation(requestId, traceId, { field: 'file', reason: 'empty' });
  }
  const enabled = form.get('enabled');
  if (
    enabled !== null &&
    (typeof enabled !== 'string' || (enabled !== 'true' && enabled !== 'false'))
  ) {
    throw validation(requestId, traceId, { field: 'enabled', reason: 'boolean_required' });
  }
  const expectedFileVersion = form.get('expectedFileVersion');
  if (
    expectedFileVersion !== null &&
    (typeof expectedFileVersion !== 'string' ||
      !/^\d+$/.test(expectedFileVersion) ||
      Number(expectedFileVersion) < 1)
  ) {
    throw validation(requestId, traceId, { field: 'expectedFileVersion', min: 1 });
  }
  return {
    file: {
      name: file.name,
      mimeType: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
    },
    ...(enabled === null ? {} : { enabled: enabled === 'true' }),
    ...(expectedFileVersion === null ? {} : { expectedFileVersion: Number(expectedFileVersion) }),
  };
}
