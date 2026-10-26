import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';
import { registerKnowledgeModels } from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import {
  apiHeaders,
  consoleCookie,
  createSpace,
  requiredEnv,
  startS4App,
  verifyResponsivePage,
  type S4AppHarness,
} from './s4-app-harness';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s4_import_e2e_${suffix}`;
const memberId = `mem_s4_import_e2e_${suffix}`;
const authToken = `s4-import-e2e-token-${suffix}`;

let app: S4AppHarness | undefined;
let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>> | undefined;
let spaceId = '';

beforeAll(async () => {
  app = await startS4App({ suffix, workspaceId, memberId, authToken });
  spaceId = await createSpace({ baseUrl: app.baseUrl, authToken, workspaceId, suffix });
  connection = await createKnowledgeMongoConnection(requiredEnv('KB_TEST_MONGO_URI'));
  registerKnowledgeModels(connection);
}, 120_000);

afterAll(async () => {
  await app?.close();
  if (connection) {
    for (const model of Object.values(registerKnowledgeModels(connection))) {
      await model.deleteMany({ workspaceId });
    }
    await connection.close();
  }
});

describe('TEST-X-FRONTEND-IMPORT and TEST-ING-002-BLOCK', () => {
  it('submits text through canonical runtime and keeps the parent Job unparsed', async () => {
    const response = await fetch(`${app!.baseUrl}/v1/knowledge/spaces/${spaceId}/imports/text`, {
      method: 'POST',
      headers: {
        ...apiHeaders({ authToken, workspaceId, idempotencyKey: `s4-text-${suffix}` }),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        knowledgeSpaceId: spaceId,
        name: 'Manual note',
        directoryId: null,
        text: 'S4 text import body',
        chunking: { trainingType: 'chunk', chunkSettingMode: 'auto' },
      }),
    });
    const payload = (await response.json()) as {
      success: boolean;
      data: { jobId: string; kind: string; status: string; result: unknown };
    };
    expect(response.status).toBe(202);
    expect(payload.data).toMatchObject({ kind: 'import', status: 'queued', result: null });
    expect(
      await connection!.models.KnowledgeJob.countDocuments({ workspaceId, kind: 'import' }),
    ).toBe(1);
    expect(await connection!.models.KnowledgeSource.countDocuments({ workspaceId })).toBe(1);
    expect(await connection!.models.KnowledgeSegment.countDocuments({ workspaceId })).toBe(0);
    expect(
      await connection!.models.KnowledgeOutboxEvent.countDocuments({
        workspaceId,
        eventType: 'import.submit',
        status: 'pending',
      }),
    ).toBe(1);
  });

  it('renders the import workbench at 360/768/1200 with no overflow or serious axe issues', async () => {
    await verifyResponsivePage({
      baseUrl: app!.baseUrl,
      path: `/spaces/${spaceId}/import?kind=text`,
      cookie: await consoleCookie({ baseUrl: app!.baseUrl, authToken, workspaceId }),
      screenshotPrefix: 'import',
    });
  });
});
