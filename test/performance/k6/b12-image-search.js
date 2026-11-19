/* global __ENV, __ITER, __VU, open */
import http from 'k6/http';
import { check } from 'k6';
import { scenario as currentScenario } from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';

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
const steadyRequests = new Counter('b12_steady_requests');
const steadyFailed = new Rate('b12_steady_failed');
const steadyDuration = new Trend('b12_steady_duration', true);
const warmupSeconds = Number(__ENV.S11_PERF_WARMUP_SECONDS || 30);
const steadyMaxVus = Number(__ENV.S11_PERF_STEADY_MAX_VUS || 60);

export const options = {
  scenarios: {
    image_search_warmup: {
      executor: 'constant-arrival-rate',
      rate: 5,
      timeUnit: '1s',
      duration: `${warmupSeconds}s`,
      preAllocatedVUs: 10,
      maxVUs: 20,
    },
    image_search: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.S11_PERF_RATE || 20),
      timeUnit: '1s',
      duration: __ENV.S11_PERF_DURATION || '2m',
      startTime: `${warmupSeconds}s`,
      preAllocatedVUs: Math.min(40, steadyMaxVus),
      maxVUs: steadyMaxVus,
    },
  },
  thresholds: {
    b12_steady_duration: ['p(95)<=900'],
    b12_steady_failed: ['rate<=0.01'],
    dropped_iterations: ['count==0'],
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
  if (currentScenario.name === 'image_search') {
    steadyRequests.add(1);
    steadyFailed.add(response.status >= 400);
    steadyDuration.add(response.timings.duration);
  }
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
