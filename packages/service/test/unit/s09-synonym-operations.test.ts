import { describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';
import { parseSynonymFileBuffer } from '../../../parse/src/s9/synonym-file.parser';
import { S09SynonymApplication } from '../../src/modules/knowledge/application/s09-synonym.application';
import { S09SynonymOperationApplication } from '../../src/modules/knowledge/application/operations/s09-synonyms';
import type {
  S09SynonymConfigView,
  S09SynonymJobView,
  S09SynonymRepositoryPort,
} from '../../src/modules/knowledge/application/s09-synonym.ports';

const spaceId = '65f1e5b2a1c9d4b7e8f01234';
const context: TenantContext = {
  workspaceId: 'ws_s9_operations',
  memberId: 'mem_s9_operations',
  requestId: 'req_s9_operations',
  traceId: 'trace_s9_operations'.padEnd(32, '0'),
  scopes: ['knowledge:read', 'knowledge:manage'],
};

const config: S09SynonymConfigView = {
  knowledgeSpaceId: spaceId,
  fileName: 'synonyms.csv',
  sizeBytes: 32,
  activeFileVersion: 1,
  enabled: true,
  schemaVersion: 2,
  status: 'rebuilding',
  mappingCount: 1,
  termCount: 2,
  version: 2,
  updatedAt: '2026-10-28T12:00:00.000Z',
  lastError: null,
};

const job: S09SynonymJobView = {
  jobId: '65f1e5b2a1c9d4b7e8f09999',
  workspaceId: context.workspaceId,
  knowledgeSpaceId: spaceId,
  kind: 'synonym_rebuild',
  resourceType: 'synonym',
  resourceId: spaceId,
  inputSnapshot: {},
  status: 'queued',
  priority: 5,
  attempts: 0,
  maxAttempts: 3,
  progress: {},
  version: 1,
  createdAt: '2026-10-28T12:00:00.000Z',
  updatedAt: '2026-10-28T12:00:00.000Z',
};

function fixture() {
  const createPendingVersion = vi.fn(async () => ({
    config,
    job,
    replayed: false,
  }));
  const toggle = vi.fn(async () => ({ ...config, enabled: false, status: 'disabled' as const }));
  const disableAndDelete = vi.fn(async () => ({
    id: spaceId,
    status: 'disabled' as const,
    jobId: null,
  }));
  const createManualRebuild = vi.fn(async () => job);
  const listMappings = vi.fn(async () => ({
    items: [
      {
        logicalMappingId: '000000000000000000000001',
        fileVersion: 1,
        standardizedTerm: '退款',
        normalizedStandardizedTerm: '退款',
        synonymTerms: ['退货'],
        normalizedSynonymTerms: ['退货'],
        fingerprint: 'a'.repeat(64),
      },
    ],
    nextCursor: null,
    hasMore: false,
    fileVersion: 1,
  }));
  const repository = {
    createPendingVersion,
    listActiveSourceIds: vi.fn(async () => ['65f1e5b2a1c9d4b7e8f01111']),
    getConfig: vi.fn(async () => config),
    toggle,
    disableAndDelete,
    createManualRebuild,
    listMappings,
    getMappingSnapshot: vi.fn(async () => [
      {
        logicalMappingId: '000000000000000000000001',
        standardizedTerm: '退款',
        normalizedStandardizedTerm: '退款',
        synonymTerms: ['退货'],
        normalizedSynonymTerms: ['退货'],
        allTerms: '退款 退货',
        fingerprint: 'a'.repeat(64),
        sourceRows: [2],
      },
    ]),
  } as unknown as S09SynonymRepositoryPort;
  const access = {
    assertPermission: vi.fn(async () => undefined),
  };
  const application = new S09SynonymApplication({
    repository,
    access,
    parser: { parse: parseSynonymFileBuffer },
    rawFiles: {
      async store(input) {
        return {
          blobId: '65f1e5b2a1c9d4b7e8f02222',
          provider: 'minio',
          bucket: 'kb-local',
          objectKey: `synonyms/${input.sha256}.csv`,
          mimeType: input.mimeType,
          sizeBytes: input.bytes.byteLength,
          etag: 'etag',
          sha256: input.sha256,
          originalName: input.fileName,
        };
      },
    },
  });
  return {
    operations: new S09SynonymOperationApplication(application),
    createPendingVersion,
    toggle,
    disableAndDelete,
    createManualRebuild,
    listMappings,
    access,
  };
}

function operation(operationId: string, overrides: Record<string, unknown> = {}) {
  return {
    operationId,
    params: { spaceId },
    query: {},
    headers: { 'idempotency-key': 'idempotency-key-0001' },
    body: {},
    context,
    ...overrides,
  };
}

function fileBody() {
  return {
    file: {
      name: 'synonyms.csv',
      mimeType: 'text/csv',
      bytes: Buffer.from('标准词,同义词\n退款,退货\n'),
    },
    enabled: true,
  };
}

describe('S9 synonym operations', () => {
  it('TEST-SEARCH-003-BLOCK dispatches GET, UPLOAD, UPDATE and pays read/manage ACL', async () => {
    const state = fixture();
    await expect(state.operations.dispatch(operation('API-SYNONYM-GET'))).resolves.toMatchObject({
      status: 200,
      data: config,
    });
    await expect(
      state.operations.dispatch(operation('API-SYNONYM-UPLOAD', { body: fileBody() })),
    ).resolves.toMatchObject({ status: 201, data: config });
    await expect(
      state.operations.dispatch(
        operation('API-SYNONYM-UPDATE', {
          body: { ...fileBody(), expectedFileVersion: 1 },
        }),
      ),
    ).resolves.toMatchObject({ status: 200, data: config });
    expect(state.createPendingVersion).toHaveBeenCalledTimes(2);
    expect(state.access.assertPermission).toHaveBeenCalledWith('space', spaceId, 'manage', context);
  });

  it('TEST-SEARCH-003-BLOCK dispatches ENABLE, DELETE, MAPPINGS and REBUILD', async () => {
    const state = fixture();
    await expect(
      state.operations.dispatch(
        operation('API-SYNONYM-ENABLE', {
          body: { enabled: false, version: 2 },
        }),
      ),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      state.operations.dispatch(operation('API-SYNONYM-DELETE', { body: { version: 3 } })),
    ).resolves.toMatchObject({ status: 202 });
    await expect(
      state.operations.dispatch(
        operation('API-SYNONYM-MAPPINGS', {
          query: { limit: '20', search: '退款' },
        }),
      ),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      state.operations.dispatch(operation('API-SYNONYM-REBUILD', { body: { version: 2 } })),
    ).resolves.toMatchObject({ status: 202, data: job });
  });

  it('TEST-SEARCH-003-BLOCK returns canonical BOM CSV with download headers', async () => {
    const state = fixture();
    const result = await state.operations.dispatch(
      operation('API-SYNONYM-DOWNLOAD', {
        params: { spaceId, fileVersion: '1' },
        headers: {},
      }),
    );
    expect(result.status).toBe(200);
    expect(result.headers).toMatchObject({
      'Content-Type': 'text/csv; charset=utf-8',
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of result.binary!.body) chunks.push(chunk);
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString('utf8')).toContain('"标准词","同义词1"');
    expect(bytes.toString('utf8')).toContain('"退款","退货"');
    expect(bytes.toString('utf8')).toContain('\r\n');
  });

  it('TEST-SEARCH-003-BLOCK rejects invalid content before persistence', async () => {
    const state = fixture();
    await expect(
      state.operations.dispatch(
        operation('API-SYNONYM-UPLOAD', {
          body: {
            file: {
              name: 'synonyms.csv',
              mimeType: 'text/csv',
              bytes: Buffer.from([0xff, 0xfe]),
            },
            enabled: true,
          },
        }),
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_SYNONYM_INVALID' } },
    });
    expect(state.createPendingVersion).not.toHaveBeenCalled();
  });
});
