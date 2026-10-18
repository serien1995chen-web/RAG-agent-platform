import { createHash } from 'node:crypto';
import { ApiErrorException, createApiError } from '@kb/contracts';
import type { ObjectStorePort } from '../../../ports/capabilities';
import type { RequestContext } from '../../../ports/types';
import type { ImageCapabilityPort } from './image-processor.adapter';

const IMAGE_EMBEDDING_DIMENSION = 1536;

function startsWith(body: Uint8Array, signature: readonly number[]): boolean {
  if (body.length < signature.length) return false;
  return signature.every((value, index) => body[index] === value);
}

/** 只做魔数识别；扩展名/Content-Type 不可信。 */
export function detectImageMimeType(body: Uint8Array): string | null {
  if (startsWith(body, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(body, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(body, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (
    startsWith(body, [0x52, 0x49, 0x46, 0x46]) &&
    body.length >= 12 &&
    String.fromCharCode(...body.subarray(8, 12)) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/** 确定性 mock 向量：同一图片字节永远得到同一向量，且归一化。 */
function mockImageVector(seedHex: string, dimension = IMAGE_EMBEDDING_DIMENSION): number[] {
  let state = 2166136261;
  for (const char of seedHex) {
    state ^= char.charCodeAt(0);
    state = Math.imul(state, 16777619) >>> 0;
  }
  const vector: number[] = new Array(dimension);
  let norm = 0;
  let cursor = state || 1;
  for (let index = 0; index < dimension; index += 1) {
    cursor = (Math.imul(cursor, 1664525) + 1013904223) >>> 0;
    const value = cursor / 4294967296 - 0.5;
    vector[index] = value;
    norm += value * value;
  }
  const scale = norm === 0 ? 1 : 1 / Math.sqrt(norm);
  return vector.map((value) => value * scale);
}

export interface MockImageCapabilityOptions {
  objectStore: ObjectStorePort;
  dimension?: number;
}

/**
 * 开发/演示用图片能力（`externalMockMode.model=mock`）：
 * 真实读取 S3 对象并校验图片魔数，再生成确定性描述与向量；不访问外部模型。
 */
export function createMockImageCapability(
  options: MockImageCapabilityOptions,
): ImageCapabilityPort {
  return {
    async describeImage(
      { imageRef, datasetId, mode, options: callOptions },
      context: RequestContext,
    ) {
      const { body } = await options.objectStore.get(
        { ref: imageRef, datasetId, options: callOptions },
        context,
      );
      const mimeType = detectImageMimeType(body);
      if (body.length === 0 || mimeType === null) {
        throw new ApiErrorException(
          createApiError({
            code: 501035,
            requestId: context.requestId,
            params: { contentType: 'image/unknown', urlHash: '' },
          }),
        );
      }
      const digest = createHash('sha256').update(body).digest('hex');
      return {
        description:
          mode === 'imageParse' ? `mock-image ${mimeType} sha256:${digest.slice(0, 12)}` : '',
        embedding: mockImageVector(digest, options.dimension),
      };
    },
  };
}
