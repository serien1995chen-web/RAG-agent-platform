import { describe, expect, it } from 'vitest';
import {
  IMAGE_BLOCK_MIXED_WEIGHT,
  IMAGE_CAPTION_WEIGHT,
  IMAGE_VECTOR_WEIGHT,
  fuseImageChannels,
  fuseTextAndImageBlocks,
} from '../../src';
import type { Candidate } from '../../src';

const spaceId = '65f1e5b2a1c9d4b7e8f01234';

function candidate(input: {
  segment: string;
  image: string;
  score: number;
  fullText?: boolean;
}): Candidate {
  return {
    docId: `${spaceId}:${input.segment}:${input.image}`,
    segmentId: input.segment,
    sourceId: '65f1e5b2a1c9d4b7e8f05678',
    knowledgeSpaceId: spaceId,
    imageIdentity: `${input.segment}:${input.image}`,
    score: input.score,
    ...(input.fullText ? { fullTextScore: input.score } : { embeddingScore: input.score }),
    scores: [{ type: input.fullText ? 'fullText' : 'embedding', value: input.score, index: 0 }],
    text: '',
  };
}

describe('TEST-SEARCH-006-BLOCK image fusion', () => {
  it('uses caption 0.3, image vector 0.7 and stable identity-aware dedupe', () => {
    const segmentA = '65f1e5b2a1c9d4b7e8f20001';
    const imageA = '65f1e5b2a1c9d4b7e8f30001';
    const fused = fuseImageChannels(
      [candidate({ segment: segmentA, image: imageA, score: 1, fullText: true })],
      [candidate({ segment: segmentA, image: imageA, score: 0.5 })],
    );
    expect(IMAGE_CAPTION_WEIGHT).toBe(0.3);
    expect(IMAGE_VECTOR_WEIGHT).toBe(0.7);
    const a = fused.find((item) => item.segmentId === segmentA);
    expect(a?.score).toBeCloseTo(1);
    expect(fused.filter((item) => item.segmentId === segmentA)).toHaveLength(1);
  });

  it('uses text block weight 1 and image block weight 0.7', () => {
    const text = candidate({
      segment: '65f1e5b2a1c9d4b7e8f20003',
      image: 'text',
      score: 1,
      fullText: true,
    });
    const image = candidate({
      segment: '65f1e5b2a1c9d4b7e8f20004',
      image: '65f1e5b2a1c9d4b7e8f30004',
      score: 1,
    });
    const fused = fuseTextAndImageBlocks([text], [image]);
    expect(IMAGE_BLOCK_MIXED_WEIGHT).toBe(0.7);
    expect(fused.find((entry) => entry.segmentId === text.segmentId)?.score).toBe(1);
    expect(fused.find((entry) => entry.segmentId === image.segmentId)?.score).toBe(0.7);
  });
});
