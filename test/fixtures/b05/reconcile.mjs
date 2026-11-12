import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const serviceRequire = createRequire(join(root, 'packages/service/package.json'));
const mongoose = serviceRequire('mongoose');
const minioRequire = createRequire(
  join(root, 'node_modules/.pnpm/minio@8.0.7/node_modules/minio/package.json'),
);
const { Client: MinioClient } = minioRequire('minio');
const pg = serviceRequire('pg');
const runId = process.env.B05_RUN_ID ?? 'b05-manual';
const outputDir = join(root, 'test-results', 'b05', runId);
const workspacePattern = '^ws_b05_';
const cleanup = process.env.B05_CLEANUP === '1';
const mongoUri = process.env.KB_TEST_MONGO_URI ?? 'mongodb://127.0.0.1:27017/kb_test';
const database = new URL(mongoUri).pathname.replace(/^\//, '') || 'kb_test';

await mkdir(outputDir, { recursive: true });
await mongoose.connect(mongoUri);
const db = mongoose.connection.db;
const collectionNames = (await db.listCollections().toArray()).map((entry) => entry.name).sort();
const readMongoCounts = async () => {
  const counts = {};
  for (const name of collectionNames) {
    counts[name] = await db.collection(name).countDocuments({
      workspaceId: { $regex: workspacePattern },
    });
  }
  return counts;
};
const mongoBefore = await readMongoCounts();
if (cleanup) {
  for (const name of collectionNames) {
    await db.collection(name).deleteMany({ workspaceId: { $regex: workspacePattern } });
  }
}
const mongoCounts = cleanup ? await readMongoCounts() : mongoBefore;
await mongoose.disconnect();

const pool = new pg.Pool({
  connectionString: process.env.KB_TEST_PG_URL,
  max: 2,
});
const vectors = {};
const tables = await pool.query(
  "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'knowledge_segment_vectors_%' ORDER BY table_name",
);
for (const row of tables.rows) {
  const result = await pool.query(
    `SELECT count(*)::int AS count FROM "${row.table_name}" WHERE workspace_id LIKE 'ws_b05_%'`,
  );
  vectors[row.table_name] = result.rows[0]?.count ?? 0;
}
await pool.end();

const minio = new MinioClient({
  endPoint: new URL(process.env.KB_TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9000').hostname,
  port: Number(new URL(process.env.KB_TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9000').port || 9000),
  useSSL: false,
  accessKey: process.env.KB_TEST_S3_ACCESS_KEY ?? 'minioadmin',
  secretKey: process.env.KB_TEST_S3_SECRET_KEY ?? 'minioadmin',
});
const bucket = process.env.KB_TEST_S3_BUCKET ?? 'kb-test';
const readObjects = async () => {
  const objects = [];
  for (const prefix of ['ws/ws_b05_', 'uploads/ws_b05_']) {
    const stream = minio.listObjectsV2(bucket, prefix, true);
    for await (const object of stream) objects.push({ name: object.name, size: object.size });
  }
  return objects;
};
const objectsBefore = await readObjects();
if (cleanup && objectsBefore.length > 0) {
  await minio.removeObjects(
    bucket,
    objectsBefore.map((object) => object.name),
  );
}
const objects = cleanup ? await readObjects() : objectsBefore;

const businessMongoCounts = Object.fromEntries(
  Object.entries(mongoCounts).filter(([, count]) => count > 0),
);
const result = {
  runId,
  workspacePattern,
  cleanupExecuted: cleanup,
  mongo: {
    database,
    collectionsChecked: Object.keys(mongoCounts).length,
    before: mongoBefore,
    remainingDocuments: businessMongoCounts,
    totalRemaining: Object.values(mongoCounts).reduce((sum, count) => sum + Number(count), 0),
  },
  pgvector: {
    profiles: vectors,
    totalRemaining: Object.values(vectors).reduce((sum, count) => sum + Number(count), 0),
  },
  minio: {
    bucket,
    before: objectsBefore,
    objects,
    totalRemaining: objects.length,
  },
  redis: {
    note: 'Idempotency records are TTL-managed and are not counted as business records.',
  },
};
await writeFile(join(outputDir, 'reconciliation.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
