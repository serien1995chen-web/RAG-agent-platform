import { describe, expect, it } from 'vitest';

const requiredNames = ['AIPROXY_BASE_URL', 'AIPROXY_API_TOKEN', 'B11_B_REAL_LLM_MODEL_ID'] as const;

describe('L1-B11-B-PARSE-004 real AIProxy QA', () => {
  it('L1-B11-B-PARSE-004-P01R fails closed when real Provider inputs are absent', async () => {
    const missing = requiredNames.filter((name) => !process.env[name]?.trim());
    if (missing.length > 0) {
      throw new Error(`BLOCKED_ENV missing ${missing.join(', ')}; no provider request was sent`);
    }

    const baseUrl = process.env.AIPROXY_BASE_URL!.replace(/\/+$/, '');
    const token = process.env.AIPROXY_API_TOKEN!;
    const model = process.env.B11_B_REAL_LLM_MODEL_ID!;
    const prompt = [
      'Read the source text and return ground question-answer pairs.',
      'Use the exact format Q1: question and A1: answer.',
      'Source: Refund requests are processed within five business days.',
    ].join('\n');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-request-id': 'b11-b-real-provider',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
          max_tokens: 512,
        }),
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      expect(payload.choices?.[0]?.message?.content).toMatch(/Q\d+\s*[:：][\s\S]*A\d+\s*[:：]/);
      expect(payload.usage?.prompt_tokens).toBeTypeOf('number');
      expect(payload.usage?.completion_tokens).toBeTypeOf('number');
    } finally {
      clearTimeout(timer);
    }
  }, 180_000);
});
