/* global __ENV, open */
import { check } from 'k6';
import http from 'k6/http';
import { scenario } from 'k6/execution';
import { Counter } from 'k6/metrics';

const importFailures = new Counter('s11_import_failed');
const uploadIds = JSON.parse(open(__ENV.S11_PERF_UPLOAD_IDS_FILE));

export const options = {
  scenarios: {
    import: {
      executor: 'shared-iterations',
      vus: 10,
      iterations: Number(__ENV.S11_PERF_IMPORT_FILES || 300),
      maxDuration: '60m',
    },
  },
  thresholds: {
    s11_import_failed: ['count==0'],
  },
};

export default function () {
  const iteration = scenario.iterationInTest;
  const uploadId = uploadIds[iteration];
  if (!uploadId) {
    importFailures.add(1);
    throw new Error(`missing upload ID for iteration ${iteration}`);
  }
  const baseUrl = __ENV.S11_PERF_BASE_URL.replace(/\/+$/, '');
  const response = http.post(
    `${baseUrl}/v1/knowledge/spaces/${__ENV.S11_PERF_SPACE_ID}/imports/files`,
    JSON.stringify({
      uploadIds: [uploadId],
      directoryId: null,
      parseProvider: 'liteparse',
      parseConfig: {},
      chunking: { trainingType: 'chunk', chunkSettingMode: 'auto' },
    }),
    {
      headers: {
        Authorization: `Bearer ${__ENV.S11_PERF_API_KEY}`,
        'X-Workspace-Id': __ENV.S11_PERF_WORKSPACE_ID,
        'Idempotency-Key': `s11-import-${String(iteration).padStart(6, '0')}`,
        'Content-Type': 'application/json',
      },
      tags: { scenario: 'import' },
    },
  );
  const accepted = check(response, {
    'import accepted with 202': (result) => result.status === 202,
  });
  if (!accepted) importFailures.add(1);
}
