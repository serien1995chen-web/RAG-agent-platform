/* global __ENV, __ITER, open */
import http from 'k6/http';
import { check } from 'k6';

const uploadIds = JSON.parse(open(__ENV.S11_PERF_UPLOAD_IDS_FILE));
if (!Array.isArray(uploadIds) || uploadIds.length === 0) {
  throw new Error('S11_PERF_UPLOAD_IDS_FILE must contain at least one image upload ID');
}

export const options = {
  scenarios: {
    image_search: {
      executor: 'constant-arrival-rate',
      rate: 20,
      timeUnit: '1s',
      duration: '2m',
      preAllocatedVUs: 20,
      maxVUs: 100,
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<=900'],
    http_req_failed: ['rate<=0.01'],
  },
};

export default function () {
  const baseUrl = __ENV.S11_PERF_BASE_URL.replace(/\/+$/, '');
  const uploadId = uploadIds[__ITER % uploadIds.length];
  const response = http.post(
    `${baseUrl}/v1/knowledge/search/image`,
    JSON.stringify({
      knowledgeSpaceId: __ENV.S11_PERF_SPACE_ID,
      query: '',
      tokenBudget: 5_000,
      imageUploadIds: [uploadId],
      searchMode: 'hybrid',
    }),
    {
      headers: {
        Authorization: `Bearer ${__ENV.S11_PERF_API_KEY}`,
        'X-Workspace-Id': __ENV.S11_PERF_WORKSPACE_ID,
        'Idempotency-Key': `b12-image-${__ITER}`,
        'Content-Type': 'application/json',
      },
      tags: { scenario: 'b12_image_search', workspace: __ENV.S11_PERF_WORKSPACE_ID },
    },
  );
  check(response, {
    'L1-B12-SEARCH-006-Q01 status is 200 or 207': (result) =>
      result.status === 200 || result.status === 207,
  });
}
