/* global __ENV, __VU, __ITER */
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  scenarios: {
    search: {
      executor: 'constant-arrival-rate',
      rate: 50,
      timeUnit: '1s',
      duration: '5m',
      preAllocatedVUs: 50,
      maxVUs: 250,
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<=900'],
    http_req_failed: ['rate<=0.01'],
  },
};

export default function () {
  const baseUrl = __ENV.S11_PERF_BASE_URL.replace(/\/+$/, '');
  const response = http.post(
    `${baseUrl}/v1/knowledge/search/hybrid`,
    JSON.stringify({
      knowledgeSpaceId: __ENV.S11_PERF_SPACE_ID,
      query: 'S11 performance search fixture',
      searchMode: 'hybrid',
      tokenBudget: 5000,
    }),
    {
      headers: {
        Authorization: `Bearer ${__ENV.S11_PERF_API_KEY}`,
        'X-Workspace-Id': __ENV.S11_PERF_WORKSPACE_ID,
        'Idempotency-Key': `s11-search-${__VU}-${__ITER}`,
        'Content-Type': 'application/json',
      },
      tags: { scenario: 'search' },
    },
  );
  check(response, {
    'search status is 200 or 207': (result) => result.status === 200 || result.status === 207,
  });
}
