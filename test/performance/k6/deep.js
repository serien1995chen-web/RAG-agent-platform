/* global __ENV, __VU, __ITER */
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  scenarios: {
    deep: {
      executor: 'constant-arrival-rate',
      rate: 10,
      timeUnit: '1s',
      duration: '3m',
      preAllocatedVUs: 10,
      maxVUs: 80,
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<=8000'],
    http_req_failed: ['rate<=0.01'],
  },
};

export default function () {
  const baseUrl = __ENV.S11_PERF_BASE_URL.replace(/\/+$/, '');
  const knowledgeSpaceId = __ENV.S11_PERF_SPACE_ID;
  const response = http.post(
    `${baseUrl}/v1/knowledge/search/deep`,
    JSON.stringify({
      knowledgeSpaceId,
      knowledgeSpaceIds: [knowledgeSpaceId],
      query: 'S11 Deep RAG performance fixture',
      tokenBudget: 7000,
      roundTokenBudget: 5000,
      maxRounds: 3,
      stopWhenNoNewEvidence: true,
      similarity: 0,
      embeddingWeight: 0.5,
      usingRerank: true,
      rerankWeight: 0.5,
    }),
    {
      headers: {
        Authorization: `Bearer ${__ENV.S11_PERF_API_KEY}`,
        'X-Workspace-Id': __ENV.S11_PERF_WORKSPACE_ID,
        'Idempotency-Key': `s11-deep-${__VU}-${__ITER}`.slice(0, 128),
        'Content-Type': 'application/json',
      },
      tags: { scenario: 'deep', test_id: 'L1-B17-SEARCH-008-Q01' },
    },
  );
  check(response, {
    'deep status is 200 or 207': (result) => result.status === 200 || result.status === 207,
    'deep response has rounds and usage': (result) => {
      try {
        const payload = result.json();
        return (
          Array.isArray(payload.data.rounds) &&
          payload.data.rounds.length > 0 &&
          typeof payload.data.usage.inputTokens === 'number' &&
          typeof payload.data.usage.outputTokens === 'number'
        );
      } catch {
        return false;
      }
    },
  });
}
