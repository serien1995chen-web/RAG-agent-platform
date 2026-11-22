import { MinioKnowledgeObjectStore } from '../../../sdk/storage/src';
import { B19_B_RUN_ID, B19_B_WORKSPACE_A, b19bTenantContext } from './support';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

const endpoint = new URL(requiredEnv('KB_TEST_S3_ENDPOINT'));
const bucket = requiredEnv('KB_TEST_S3_BUCKET');
const context = b19bTenantContext('bucket-bootstrap', B19_B_WORKSPACE_A);
const store = new MinioKnowledgeObjectStore({
  provider: 'minio',
  endPoint: endpoint.hostname,
  port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)),
  useSSL: endpoint.protocol === 'https:',
  accessKey: requiredEnv('KB_TEST_S3_ACCESS_KEY'),
  secretKey: requiredEnv('KB_TEST_S3_SECRET_KEY'),
  region: process.env.KB_TEST_S3_REGION || 'us-east-1',
  bucket,
});

await store.ensureBucket(context);
process.stdout.write(
  `${JSON.stringify({ bucket, runId: B19_B_RUN_ID, workspaceId: context.workspaceId })}\n`,
);
