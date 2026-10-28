import { createKnowledgeError } from '@kb/contracts';

export const S8_IMAGE_MAX_BATCH = 10;
export const S8_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const S8_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

export type S8ImageMimeType = (typeof S8_IMAGE_MIME_TYPES)[number];

const EXTENSIONS: Readonly<Record<S8ImageMimeType, readonly string[]>> = {
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/webp': ['webp'],
  'image/gif': ['gif'],
};

export interface S8ImagePolicyContext {
  requestId: string;
  traceId: string;
}

function imageError(
  code: 'KNOWLEDGE_PAYLOAD_TOO_LARGE' | 'KNOWLEDGE_UNSUPPORTED_CONTENT',
  context: S8ImagePolicyContext,
  details: Record<string, unknown>,
) {
  return createKnowledgeError({
    code,
    requestId: context.requestId,
    traceId: context.traceId,
    details,
  });
}

function extensionOf(fileName: string): string {
  const index = fileName.lastIndexOf('.');
  return index < 0 ? '' : fileName.slice(index + 1).toLowerCase();
}

export function isS8ImageMimeType(value: string): value is S8ImageMimeType {
  return (S8_IMAGE_MIME_TYPES as readonly string[]).includes(value.toLowerCase());
}

export function isS8KnowledgeImage(input: { mimeType: string; fileName: string }): boolean {
  const mimeType = input.mimeType.toLowerCase().split(';')[0]?.trim() ?? '';
  if (!isS8ImageMimeType(mimeType)) return false;
  return EXTENSIONS[mimeType].includes(extensionOf(input.fileName));
}

export function detectS8ImageMime(bytes: Uint8Array): S8ImageMimeType | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return 'image/gif';
  }
  return null;
}

export function assertS8ImageCount(count: number, context: S8ImagePolicyContext): void {
  if (!Number.isInteger(count) || count < 1 || count > S8_IMAGE_MAX_BATCH) {
    throw imageError('KNOWLEDGE_PAYLOAD_TOO_LARGE', context, {
      field: 'imageUploadIds',
      min: 1,
      max: S8_IMAGE_MAX_BATCH,
      actual: count,
    });
  }
}

export function assertS8ImageMedia(
  input: {
    mimeType: string;
    fileName: string;
    sizeBytes: number;
    bytes?: Uint8Array;
  },
  context: S8ImagePolicyContext,
): S8ImageMimeType {
  if (
    !Number.isInteger(input.sizeBytes) ||
    input.sizeBytes < 1 ||
    input.sizeBytes > S8_IMAGE_MAX_BYTES
  ) {
    throw imageError('KNOWLEDGE_PAYLOAD_TOO_LARGE', context, {
      field: 'sizeBytes',
      min: 1,
      max: S8_IMAGE_MAX_BYTES,
      actual: input.sizeBytes,
    });
  }
  const declaredMime = input.mimeType.toLowerCase().split(';')[0]?.trim() ?? '';
  if (!isS8ImageMimeType(declaredMime)) {
    throw imageError('KNOWLEDGE_UNSUPPORTED_CONTENT', context, {
      field: 'mimeType',
      reason: 'unsupported_image_type',
      actual: declaredMime,
    });
  }
  if (!EXTENSIONS[declaredMime].includes(extensionOf(input.fileName))) {
    throw imageError('KNOWLEDGE_UNSUPPORTED_CONTENT', context, {
      field: 'fileName',
      reason: 'extension_mime_mismatch',
      mimeType: declaredMime,
    });
  }
  if (input.bytes !== undefined) {
    const detected = detectS8ImageMime(input.bytes);
    if (detected !== declaredMime) {
      throw imageError('KNOWLEDGE_UNSUPPORTED_CONTENT', context, {
        field: 'bytes',
        reason: 'magic_mime_mismatch',
        declaredMime,
        detectedMime: detected,
      });
    }
  }
  return declaredMime;
}
