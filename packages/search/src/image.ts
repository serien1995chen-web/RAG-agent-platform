import { minMaxNormalize, stableSortCandidates } from './fusion';
import type { Candidate } from './types';

export const IMAGE_CAPTION_WEIGHT = 0.3;
export const IMAGE_VECTOR_WEIGHT = 0.7;
export const IMAGE_BLOCK_MIXED_WEIGHT = 0.7;
export const TEXT_BLOCK_WEIGHT = 1;

function imageKey(candidate: Candidate): string {
  return [
    candidate.knowledgeSpaceId,
    candidate.segmentId ?? candidate.docId,
    candidate.imageIdentity ?? '',
  ].join(':');
}

function withImageIdentity(candidate: Candidate): Candidate {
  const identity =
    candidate.imageIdentity ??
    (candidate.segment?.imageBlobRefId
      ? `${candidate.segmentId ?? candidate.docId}:${candidate.segment.imageBlobRefId}`
      : undefined);
  return identity ? { ...candidate, imageIdentity: identity } : { ...candidate };
}

export function fuseImageChannels(
  captionCandidates: readonly Candidate[],
  imageVectorCandidates: readonly Candidate[],
): Candidate[] {
  const fused = new Map<string, Candidate>();
  const captions = captionCandidates.map(withImageIdentity);
  const images = imageVectorCandidates.map(withImageIdentity);
  const captionScores = minMaxNormalize(captions.map((candidate) => candidate.score));
  const imageScores = minMaxNormalize(images.map((candidate) => candidate.score));
  captions.forEach((candidate, index) => {
    const key = imageKey(candidate);
    fused.set(key, {
      ...candidate,
      docId: key,
      fullTextScore: candidate.fullTextScore ?? candidate.score,
      score: (captionScores[index] ?? 0) * IMAGE_CAPTION_WEIGHT,
      scores: [...candidate.scores],
    });
  });
  images.forEach((candidate, index) => {
    const key = imageKey(candidate);
    const current = fused.get(key);
    const contribution = (imageScores[index] ?? 0) * IMAGE_VECTOR_WEIGHT;
    fused.set(key, {
      ...(current ?? candidate),
      docId: key,
      imageIdentity: candidate.imageIdentity,
      embeddingScore: candidate.embeddingScore ?? candidate.score,
      score: (current?.score ?? 0) + contribution,
      scores: [...(current?.scores ?? []), ...candidate.scores],
      text: current?.text || candidate.text,
    });
  });
  return stableSortCandidates([...fused.values()]);
}

export function fuseTextAndImageBlocks(
  textCandidates: readonly Candidate[],
  imageBlockCandidates: readonly Candidate[],
  weights: { text?: number; image?: number } = {},
): Candidate[] {
  const textWeight = weights.text ?? TEXT_BLOCK_WEIGHT;
  const imageWeight = weights.image ?? IMAGE_BLOCK_MIXED_WEIGHT;
  const textScores = minMaxNormalize(textCandidates.map((candidate) => candidate.score));
  const imageScores = minMaxNormalize(imageBlockCandidates.map((candidate) => candidate.score));
  return stableSortCandidates([
    ...textCandidates.map((candidate, index) => ({
      ...candidate,
      score: (textScores[index] ?? 0) * textWeight,
    })),
    ...imageBlockCandidates.map(withImageIdentity).map((candidate, index) => ({
      ...candidate,
      score: (imageScores[index] ?? 0) * imageWeight,
    })),
  ]);
}
