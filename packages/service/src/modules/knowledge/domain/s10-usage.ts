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

export type S10UsageUnit =
  | 'page'
  | 'image'
  | 'token'
  | 'vector'
  | 'byte'
  | 'request'
  | 'second'
  | 'character';

export const S10_USAGE_KINDS = Object.freeze([
  'llm',
  'vlm',
  'embedding',
  'rerank',
  'ocr',
  'parse',
  'image',
  'stt',
  'tts',
  'storage',
  'sync',
] as const satisfies readonly S10UsageKind[]);

export const S10_USAGE_UNITS = Object.freeze([
  'page',
  'image',
  'token',
  'vector',
  'byte',
  'request',
  'second',
  'character',
] as const satisfies readonly S10UsageUnit[]);

const USAGE_UNITS_BY_KIND = Object.freeze({
  llm: Object.freeze(['token'] as const),
  vlm: Object.freeze(['token'] as const),
  embedding: Object.freeze(['token', 'vector'] as const),
  rerank: Object.freeze(['token', 'vector'] as const),
  ocr: Object.freeze(['page', 'request'] as const),
  parse: Object.freeze(['page', 'request'] as const),
  image: Object.freeze(['image', 'request'] as const),
  stt: Object.freeze(['second', 'request'] as const),
  tts: Object.freeze(['second', 'character', 'request'] as const),
  storage: Object.freeze(['byte', 'vector'] as const),
  sync: Object.freeze(['character', 'request'] as const),
} satisfies Record<S10UsageKind, readonly S10UsageUnit[]>);

export function assertSafePointsMicros(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('pointsMicros must be a non-negative safe integer');
  }
  return value;
}

export function assertSafeUsageInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

export function assertUsageContract(input: {
  kind: S10UsageKind;
  unit: S10UsageUnit;
  quantity: number;
  inputTokens?: number;
  outputTokens?: number;
}): void {
  if (!(S10_USAGE_KINDS as readonly string[]).includes(input.kind)) {
    throw new RangeError('kind must be a supported usage kind');
  }
  if (!(S10_USAGE_UNITS as readonly string[]).includes(input.unit)) {
    throw new RangeError('unit must be a supported usage unit');
  }
  if (!(USAGE_UNITS_BY_KIND[input.kind] as readonly S10UsageUnit[]).includes(input.unit)) {
    throw new RangeError(`unit ${input.unit} is incompatible with kind ${input.kind}`);
  }
  assertSafeUsageInteger(input.quantity, 'quantity');
  if (input.inputTokens !== undefined) {
    assertSafeUsageInteger(input.inputTokens, 'inputTokens');
  }
  if (input.outputTokens !== undefined) {
    assertSafeUsageInteger(input.outputTokens, 'outputTokens');
  }
}

export function computeUsagePointsMicros(input: {
  kind: S10UsageKind;
  status: number | null;
  intent: boolean;
  quantity: number;
  unit: S10UsageUnit;
  inputTokens?: number;
  outputTokens?: number;
  pricing: S10PricingProfile;
  now?: Date;
}): number {
  assertUsageContract(input);
  if (input.intent || input.status === null || input.status < 200 || input.status >= 300) {
    return 0;
  }
  const quantity = input.quantity;
  const inputTokens = input.inputTokens ?? 0;
  const outputTokens = input.outputTokens ?? 0;
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
