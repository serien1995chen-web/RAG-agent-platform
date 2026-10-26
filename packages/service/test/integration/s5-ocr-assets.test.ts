import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S5OcrApplication } from '../../src/modules/knowledge/application/s5-ocr.application';
import type { S5OcrProviderConfig } from '../../src/modules/knowledge/application/s5-ocr-ports';
import { S5UsageRepository } from '../../src/modules/knowledge/repository/s5-usage.repository';
import { registerKnowledgeModels } from '../../src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s5_ocr_${suffix}`;
const knowledgeSpaceId = `65f1e5b2a1c9d4b7e8f2${suffix.slice(0, 4)}`;
const sourceId = `65f1e5b2a1c9d4b7e8f3${suffix.slice(0, 4)}`;
const context: TenantContext = {
  workspaceId,
  memberId: `mem_s5_ocr_${suffix}`,
  requestId: `req_s5_ocr_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write'],
};
const config: S5OcrProviderConfig = {
  provider: 'sangfor',
  credentialProfileId: 'env:OCR_PROFILE',
  keepHeaderFooter: false,
  keepAppendix: true,
  imageAnalysis: false,
  chartAnalysis: false,
  timeoutMs: 10_000,
  fallbackProvider: 'none',
  imageHandling: 'upload_to_storage',
};

let connection: mongoose.Connection;

beforeAll(async () => {
  const uri = new URL(process.env.KB_TEST_MONGO_URI ?? 'mongodb://127.0.0.1:27017/kb_s5_ocr');
  if (uri.hostname === '127.0.0.1' || uri.hostname === 'localhost') {
    uri.searchParams.set('directConnection', 'true');
  }
  connection = mongoose.createConnection(uri.toString(), { serverSelectionTimeoutMS: 5_000 });
  await connection.asPromise();
}, 60_000);

afterAll(async () => {
  if (!connection) return;
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId });
  }
  await connection.close();
});

describe('TEST-PARSE-002-BLOCK OCR image and usage persistence', () => {
  it('materializes image references and writes OCR usage plus outbox in Mongo', async () => {
    let sourceChecks = 0;
    let fetched = 0;
    let stored = 0;
    const application = new S5OcrApplication({
      provider: {
        async parse() {
          return {
            markdown: 'OCR ![scan](https://cdn.example.invalid/scan.png)',
            pages: [
              {
                pageNumber: 1,
                text: 'OCR ![scan](https://cdn.example.invalid/scan.png)',
                assets: [],
              },
            ],
            assets: [],
            diagnostics: [],
            usage: [{ provider: 'sangfor', unit: 'page', quantity: 1, status: 200 }],
            requestEvidence: { provider: 'sangfor', pageCount: 1 },
          };
        },
      },
      usage: new S5UsageRepository(connection),
      remoteAssets: {
        async fetch() {
          fetched += 1;
          return {
            bytes: new Uint8Array([1, 2, 3]),
            mimeType: 'image/png',
            sha256: 'image-hash',
          };
        },
      },
      assetSink: {
        async putImage(input) {
          stored += 1;
          expect(input.sourceId).toBe(sourceId);
          expect(input.sourceVersion).toBe(1);
          return { objectRefId: 'materialized-image', markdownUrl: 'object://materialized' };
        },
      },
      sourceGuard: {
        async assertSource(input) {
          sourceChecks += 1;
          expect(input.workspaceId).toBe(workspaceId);
          expect(input.sourceId).toBe(sourceId);
        },
      },
    });
    const result = await application.parse({
      workspaceId,
      knowledgeSpaceId,
      sourceId,
      sourceVersion: 1,
      bytes: Buffer.from('%PDF-1.4 fixture'),
      fileName: 'fixture.pdf',
      mimeType: 'application/pdf',
      config,
      timeoutMs: 10_000,
      requestId: context.requestId,
      traceId: context.traceId,
      context,
    });
    expect(sourceChecks).toBe(1);
    expect(fetched).toBe(1);
    expect(stored).toBe(1);
    expect(result.markdown).toContain('object://materialized');
    expect(result.assets[0]?.objectRefId).toBe('materialized-image');
    const models = registerKnowledgeModels(connection);
    expect(await models.KnowledgeUsageEvent.countDocuments({ workspaceId, eventType: 'ocr' })).toBe(
      1,
    );
    expect(await models.KnowledgeOutboxEvent.countDocuments({ workspaceId })).toBe(1);
  });
});
