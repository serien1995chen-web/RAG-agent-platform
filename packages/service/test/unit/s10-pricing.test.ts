import { describe, expect, it } from 'vitest';
import {
  FIXTURE_V1_PRICING,
  FREE_V1_QUOTA,
  ZERO_V1_PRICING,
  canonicalJson,
  loadS10PricingProfile,
} from '../../src/shared/config/s10-profiles';
import {
  computeUsagePointsMicros,
  formatPointsMicros,
} from '../../src/modules/knowledge/domain/s10-usage';

describe('S10 pricing and quota profiles', () => {
  it('TEST-S10-PRICING-HASH keeps canonical versions stable', () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(ZERO_V1_PRICING.name).toBe('zero-v1');
    expect(FIXTURE_V1_PRICING.name).toBe('fixture-v1');
    expect(ZERO_V1_PRICING.version).toMatch(/^[a-f0-9]{64}$/);
    expect(FIXTURE_V1_PRICING.version).toMatch(/^[a-f0-9]{64}$/);
    expect(FREE_V1_QUOTA.aiPointsLimit).toBe(100);
    expect(loadS10PricingProfile({})).toEqual(ZERO_V1_PRICING);
    expect(loadS10PricingProfile({ KB_USAGE_PRICING_PROFILE: 'fixture-v1' })).toEqual(
      FIXTURE_V1_PRICING,
    );
  });

  it('applies zero, token, page and audio micros without floating accumulation', () => {
    expect(
      computeUsagePointsMicros({
        kind: 'llm',
        status: 200,
        intent: false,
        quantity: 1100,
        unit: 'token',
        inputTokens: 1000,
        outputTokens: 100,
        pricing: ZERO_V1_PRICING,
      }),
    ).toBe(0);
    expect(
      computeUsagePointsMicros({
        kind: 'llm',
        status: 200,
        intent: false,
        quantity: 1100,
        unit: 'token',
        inputTokens: 1000,
        outputTokens: 100,
        pricing: FIXTURE_V1_PRICING,
      }),
    ).toBe(1_200_000);
    expect(
      computeUsagePointsMicros({
        kind: 'ocr',
        status: 200,
        intent: false,
        quantity: 2,
        unit: 'page',
        pricing: FIXTURE_V1_PRICING,
      }),
    ).toBe(2_000_000);
    expect(
      computeUsagePointsMicros({
        kind: 'stt',
        status: 200,
        intent: false,
        quantity: 60,
        unit: 'second',
        pricing: FIXTURE_V1_PRICING,
      }),
    ).toBe(1_000_000);
    expect(formatPointsMicros(1_200_000)).toBe('1.200000');
  });

  it('does not charge failed or intent events', () => {
    for (const [intent, status] of [
      [true, null],
      [false, 500],
      [false, null],
    ] as const) {
      expect(
        computeUsagePointsMicros({
          kind: 'embedding',
          status,
          intent,
          quantity: 1000,
          unit: 'token',
          inputTokens: 1000,
          pricing: FIXTURE_V1_PRICING,
        }),
      ).toBe(0);
    }
  });
});
