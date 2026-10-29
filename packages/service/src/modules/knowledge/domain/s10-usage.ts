import { canonicalJson, type S10PricingProfile } from '../../../shared/config/s10-profiles';

export type S10UsageKind =
  | 'llm'
  | 'vlm'
  | 'embedding'
  | 'rerank'
  | 'ocr'
  | 'parse'
  | 'image'
  | 'stt'
  | 'tts'
  | 'storage'
  | 'sync';

export function assertSafePointsMicros(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('pointsMicros must be a non-negative safe integer');
  }
  return value;
}

function safeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

export function computeUsagePointsMicros(input: {
  kind: S10UsageKind;
  status: number | null;
  intent: boolean;
  quantity: number;
  unit: 'page' | 'image' | 'token' | 'vector' | 'byte' | 'request' | 'second';
  inputTokens?: number;
  outputTokens?: number;
  pricing: S10PricingProfile;
  now?: Date;
}): number {
  if (input.intent || input.status === null || input.status < 200 || input.status >= 300) {
    return 0;
  }
  const quantity = safeInteger(input.quantity, 'quantity');
  const inputTokens = safeInteger(input.inputTokens ?? 0, 'inputTokens');
  const outputTokens = safeInteger(input.outputTokens ?? 0, 'outputTokens');
  switch (input.kind) {
    case 'llm':
    case 'vlm':
      return assertSafePointsMicros(
        Math.round(
          (inputTokens * input.pricing.llmInputPer1kTokensMicros +
            outputTokens * input.pricing.llmOutputPer1kTokensMicros) /
            1000,
        ),
      );
    case 'embedding':
      return assertSafePointsMicros(
        Math.round(
          (Math.max(inputTokens, quantity) * input.pricing.embeddingPer1kTokensMicros) / 1000,
        ),
      );
    case 'rerank':
      return assertSafePointsMicros(
        Math.round(
          (Math.max(inputTokens, quantity) * input.pricing.rerankPer1kTokensMicros) / 1000,
        ),
      );
    case 'ocr':
    case 'parse':
      if (input.unit !== 'page') return 0;
      return assertSafePointsMicros(quantity * input.pricing.pageMicros);
    case 'image':
      if (input.unit !== 'image') return 0;
      return assertSafePointsMicros(quantity * input.pricing.imageMicros);
    case 'stt':
    case 'tts':
      if (input.unit !== 'second') return 0;
      return assertSafePointsMicros(
        Math.round((quantity * input.pricing.audioPerMinuteMicros) / 60),
      );
    case 'storage':
    case 'sync':
      return 0;
  }
}

export function canonicalPricingJson(pricing: S10PricingProfile): string {
  const { version: _version, ...core } = pricing;
  return canonicalJson(core);
}

export function pointsFromMicros(micros: number): number {
  return assertSafePointsMicros(micros) / 1_000_000;
}

export function formatPointsMicros(micros: number): string {
  return (assertSafePointsMicros(micros) / 1_000_000).toFixed(6);
}
