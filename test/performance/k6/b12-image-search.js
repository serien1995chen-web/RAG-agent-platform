/* global __ENV, __ITER, __VU, open */
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const uploadIds = JSON.parse(open(__ENV.S11_PERF_UPLOAD_IDS_FILE));
if (!Array.isArray(uploadIds) || uploadIds.length === 0) {
  throw new Error('S11_PERF_UPLOAD_IDS_FILE must contain at least one image upload ID');
}

const statusCodes = [200, 207, 400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504];
const statusCounters = Object.fromEntries(
  statusCodes.map((status) => [`b12_status_${status}`, new Counter(`b12_status_${status}`)]),
);
const otherStatusCounter = new Counter('b12_status_other');
const errorCodes = [
  'KNOWLEDGE_VALIDATION_FAILED',
  'KNOWLEDGE_RATE_LIMITED',
  'KNOWLEDGE_NOT_FOUND',
  'KNOWLEDGE_FORBIDDEN',
  'KNOWLEDGE_DEPENDENCY_TIMEOUT',
  'KNOWLEDGE_MODEL_FAILED',
  'KNOWLEDGE_INTERNAL_ERROR',
];
const errorCodeCounters = Object.fromEntries(
  errorCodes.map((code) => [`b12_error_${code}`, new Counter(`b12_error_${code}`)]),
);
const otherErrorCodeCounter = new Counter('b12_error_other');

export const options = {
  scenarios: {
    image_search: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.S11_PERF_RATE || 20),
      timeUnit: '1s',
      duration: __ENV.S11_PERF_DURATION || '2m',
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
      query: __ENV.S11_PERF_QUERY || 'refund flow diagram',
      tokenBudget: 5_000,
      imageUploadIds: [uploadId],
      searchMode: 'hybrid',
    }),
    {
      headers: {
        Authorization: `Bearer ${__ENV.S11_PERF_API_KEY}`,
        'X-Workspace-Id': __ENV.S11_PERF_WORKSPACE_ID,
        'Idempotency-Key': `b12-image-search-${__VU}-${__ITER}`,
        'Content-Type': 'application/json',
      },
      tags: { scenario: 'b12_image_search', workspace: __ENV.S11_PERF_WORKSPACE_ID },
    },
  );
  const statusCounter = statusCounters[`b12_status_${response.status}`];
  if (statusCounter) statusCounter.add(1);
  else otherStatusCounter.add(1);
  if (response.status >= 400) {
    let errorCode = '';
    try {
      errorCode = JSON.parse(response.body)?.error?.code ?? '';
    } catch {
      errorCode = '';
    }
    const errorCodeCounter = errorCodeCounters[`b12_error_${errorCode}`];
    if (errorCodeCounter) errorCodeCounter.add(1);
    else otherErrorCodeCounter.add(1);
  }
  check(response, {
    'L1-B12-SEARCH-006-Q01 status is 200 or 207': (result) =>
      result.status === 200 || result.status === 207,
  });
}
