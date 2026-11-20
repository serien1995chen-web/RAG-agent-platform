/* global __ENV, __VU, __ITER */
import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';

const recallAt10 = new Rate('b16_recall_at_10');

export const options = {
  scenarios: {
    b16_search: {
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
    b16_recall_at_10: ['rate>=1'],
  },
};

export default function () {
  const baseUrl = __ENV.B16_A_PERF_BASE_URL.replace(/\/+$/, '');
  const fixture = JSON.parse(__ENV.B16_A_PERF_QUERY);
  const response = http.post(
    `${baseUrl}/v1/knowledge/search/hybrid`,
    JSON.stringify({
      knowledgeSpaceId: __ENV.B16_A_PERF_SPACE_ID,
      query: fixture.query,
      searchMode: 'hybrid',
      tokenBudget: 5000,
    }),
    {
      headers: {
        Authorization: `Bearer ${__ENV.B16_A_PERF_API_KEY}`,
        'X-Workspace-Id': __ENV.B16_A_PERF_WORKSPACE_ID,
        'X-Request-Id': `b16-a-${__VU}-${__ITER}`,
        'Content-Type': 'application/json',
      },
      tags: { scenario: 'b16_search' },
    },
  );
  const body = response.json();
  const ids = Array.isArray(body?.items)
    ? body.items.map((item) => item?.segment?.id).filter(Boolean)
    : [];
  recallAt10.add(ids.slice(0, 10).includes(fixture.segmentId));
  check(response, {
    'search returns 200 or explicit partial': (result) =>
      result.status === 200 || result.status === 207,
    'target is visible in top 10': () => ids.slice(0, 10).includes(fixture.segmentId),
  });
}
