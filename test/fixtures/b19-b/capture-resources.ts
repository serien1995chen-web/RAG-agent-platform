import {
  createKnowledgeMongoConnection,
  registerKnowledgeModels,
} from '../../../packages/service/src';
import { B19_B_RUN_ID, B19_B_WORKSPACE_A, B19_B_WORKSPACE_B, writeB19BEvidence } from './support';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

const connection = await createKnowledgeMongoConnection(requiredEnv('KB_TEST_MONGO_URI'));
try {
  const models = registerKnowledgeModels(connection);
  const counts = Object.fromEntries(
    await Promise.all(
      Object.entries(models).map(async ([name, model]) => [
        name,
        await model.countDocuments({
          workspaceId: { $in: [B19_B_WORKSPACE_A, B19_B_WORKSPACE_B] },
        }),
      ]),
    ),
  );
  const runPrefixCounts = Object.fromEntries(
    await Promise.all(
      Object.entries(models).map(async ([name, model]) => [
        name,
        await model.countDocuments({ workspaceId: new RegExp(`^${B19_B_RUN_ID}`) }),
      ]),
    ),
  );
  await writeB19BEvidence('resource-reconciliation.json', {
    runId: B19_B_RUN_ID,
    workspaceIds: [B19_B_WORKSPACE_A, B19_B_WORKSPACE_B],
    collectionCounts: counts,
    runPrefixCounts,
    orphanDocumentCount: Object.values(counts).reduce((sum, value) => sum + value, 0),
  });
  process.stdout.write(
    `${JSON.stringify({
      runId: B19_B_RUN_ID,
      orphanDocumentCount: Object.values(counts).reduce((sum, value) => sum + value, 0),
    })}\n`,
  );
} finally {
  await connection.close();
}
