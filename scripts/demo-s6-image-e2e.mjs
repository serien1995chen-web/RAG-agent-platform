#!/usr/bin/env node
/* global fetch, FormData, Blob */
/**
 * S6 真实图片链路 E2E（demo 验收脚本，不引入依赖）：
 * PNG → presign → uploadPart → completeMultipart → create/images → 训练 → 数据 → 检索 → 删除。
 * 输出 s6-green.json；数据库断言由 scripts/demo-s6-db-assert.sh 读取同一批 ID 完成。
 */
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.DEMO_BASE_URL ?? 'http://127.0.0.1:3200';
const EVIDENCE =
  process.env.S6_EVIDENCE_DIR ??
  '/mnt/c/Users/Administrator/Documents/Codex/2026-10-16/files-mentioned-by-the-user-p0-2/outputs/kb-demo-s6-fix-20261018';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP478+AFWEXHbQSAOBoU4FwyX8rAAAAAElFTkSuQmCC',
  'base64',
);

const steps = [];

async function call(step, method, path, body, headers = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 2000) };
  }
  const record = {
    step,
    method,
    path,
    status: response.status,
    code: json?.code ?? null,
    messageKey: json?.messageKey ?? null,
    requestId: json?.requestId ?? null,
    response: json,
  };
  steps.push(record);
  return record;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const startedAt = new Date().toISOString();
const stamp = Date.now();

const created = await call('S6-1', 'POST', '/api/core/dataset/create', {
  name: `[DEMO] S6-e2e-${stamp}`,
  type: 'dataset',
  models: { embeddingModel: 'bge-m3' },
});
const datasetId = created.response?.data?.datasetId;
assert(created.status === 200 && datasetId, 'create dataset failed');

const presign = await call('S6-2', 'POST', '/api/core/dataset/file/presignUpload', {
  datasetId,
  filename: 'demo.png',
  size: PNG.length,
  mime: 'image/png',
});
const fileId = presign.response?.data?.fileId;
const uploadUrl = presign.response?.data?.uploadUrl;
assert(presign.status === 200 && fileId && uploadUrl, 'presign failed');

const checksum = createHash('sha256').update(PNG).digest('hex');
const form = new FormData();
form.append('partNumber', '1');
form.append('checksum', checksum);
form.append('chunk', new Blob([PNG], { type: 'image/png' }), 'demo.png');
const uploadResponse = await fetch(`${BASE}${uploadUrl}?fileId=${encodeURIComponent(fileId)}`, {
  method: 'POST',
  body: form,
});
const uploadJson = await uploadResponse.json();
steps.push({
  step: 'S6-3',
  method: 'POST',
  path: `${uploadUrl}?fileId=…`,
  status: uploadResponse.status,
  code: uploadJson?.code ?? null,
  requestId: uploadJson?.requestId ?? null,
  response: uploadJson,
});
const etag = String(uploadJson?.data?.etag ?? '')
  .replace(/^"|"$/g, '')
  .toLowerCase();
assert(uploadResponse.status === 200 && etag, 'uploadPart failed');

const multipartHash = `${createHash('md5').update(Buffer.from(etag, 'hex')).digest('hex')}-1`;
const completed = await call('S6-3', 'POST', '/api/core/dataset/file/completeMultipart', {
  fileId,
  parts: [{ partNumber: 1, etag }],
  hash: multipartHash,
});
const fileRef = completed.response?.data?.fileRef;
assert(completed.status === 200 && fileRef, 'completeMultipart failed');

const images = await call('S6-4', 'POST', '/api/core/dataset/collection/create/images', {
  datasetId,
  images: [fileRef],
  trainingType: 'auto',
});
const collectionId = images.response?.data?.collectionId;
const item = images.response?.data?.items?.[0];
assert(
  images.status === 200 && collectionId,
  `create/images failed: ${JSON.stringify(images.response)}`,
);
assert(images.response?.data?.items?.length === 1, 'items length must be 1');
assert(item?.state === 'success', `image item failed: ${item?.errorMsg}`);

let trainingState = 'unknown';
for (let attempt = 0; attempt < 30; attempt += 1) {
  const status = await call(
    'S6-5',
    'GET',
    `/api/core/dataset/collection/trainingStatus?collectionId=${collectionId}`,
  );
  trainingState = status.response?.data?.trainingState ?? 'unknown';
  if (trainingState === 'ready' || trainingState === 'error') break;
  await sleep(1000);
}
assert(trainingState === 'ready', `training state=${trainingState}`);

const list = await call(
  'S6-6',
  'GET',
  `/api/core/dataset/data/list?collectionId=${collectionId}&page=1&limit=20`,
);
const total = list.response?.data?.total ?? 0;
assert(list.status === 200 && total >= 1, `data total=${total}`);

const search = await call('S6-7', 'POST', '/api/core/dataset/searchTest', {
  datasetId,
  text: '图片',
  limit: 5,
});
const citations = search.response?.data?.searchRes?.citations ?? [];
assert(search.status === 200 && citations.length >= 1, 'search citations=0');

let jobId = null;
if (process.env.S6_KEEP === '1') {
  steps.push({
    step: 'S6-8',
    method: 'SKIP',
    path: '/api/core/dataset/delete',
    status: 0,
    note: 'S6_KEEP=1：保留数据用于 DB 断言，删除由后续运行/清理脚本执行',
  });
} else {
  const deleted = await call(
    'S6-8',
    'POST',
    '/api/core/dataset/delete',
    { datasetId },
    { 'idempotency-key': `s6-e2e-${stamp}` },
  );
  jobId = deleted.response?.data?.jobId;
  assert(deleted.status === 200 && jobId, 'delete failed');
  const job = await call(
    'S6-8',
    'GET',
    `/api/core/dataset/delete-jobs/${encodeURIComponent(jobId)}`,
  );
  assert(job.status === 200, 'delete job read failed');
}

const result = {
  scenarioId: 'S6',
  startedAt,
  finishedAt: new Date().toISOString(),
  baseline: { branch: 'feat/kb-demo-ui' },
  environment: { appUrl: BASE, modelMode: 'mock', storage: 'minio' },
  ids: { datasetId, collectionId, imageId: item?.imageId, dataId: item?.dataId, jobId },
  assertions: {
    items: images.response?.data?.items?.length,
    itemState: item?.state,
    trainingState,
    dataTotal: total,
    citations: citations.length,
  },
  steps,
};
mkdirSync(resolve(EVIDENCE, '02-green'), { recursive: true });
writeFileSync(resolve(EVIDENCE, '02-green/s6-green.json'), JSON.stringify(result, null, 2));
writeFileSync(resolve(EVIDENCE, '02-green/s6-ids.json'), JSON.stringify(result.ids, null, 2));
console.log(JSON.stringify(result.assertions, null, 2));
console.log(`evidence: ${resolve(EVIDENCE, '02-green/s6-green.json')}`);
