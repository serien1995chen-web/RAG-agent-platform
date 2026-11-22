import Redis from '../../../packages/service/node_modules/ioredis/built/index.js';
import { B19_B_RUN_ID, writeB19BEvidence } from './support';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

const redis = new Redis(requiredEnv('KB_TEST_REDIS_URL'), {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});
await redis.connect();
try {
  const keys = await redis.keys('*');
  const runPrefixed = keys.filter((key) => key.includes(B19_B_RUN_ID));
  const queueKeys = keys.filter((key) => key.startsWith('bull:knowledge-'));
  const rateKeys = keys.filter((key) => key.startsWith('kb-rate:'));
  await writeB19BEvidence('redis-key-inventory.json', {
    runId: B19_B_RUN_ID,
    databaseSize: keys.length,
    runPrefixedKeyCount: runPrefixed.length,
    globalQueueKeyCount: queueKeys.length,
    rateKeyCount: rateKeys.length,
    sample: keys.sort().slice(0, 80),
    runPrefixRequirementMet: runPrefixed.length === keys.length,
  });
  process.stdout.write(
    `${JSON.stringify({
      databaseSize: keys.length,
      runPrefixedKeyCount: runPrefixed.length,
      globalQueueKeyCount: queueKeys.length,
    })}\n`,
  );
} finally {
  await redis.quit();
}
