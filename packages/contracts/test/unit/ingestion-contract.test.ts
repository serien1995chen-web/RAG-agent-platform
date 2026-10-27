import { describe, expect, it } from 'vitest';
import {
  ConnectorConnectSchema,
  CustomApiConnectorConfigSchema,
  ImportFilesSchema,
  ImportTextSchema,
} from '../../src/knowledge/ingestion-contract';

const objectId = '65f1e5b2a1c9d4b7e8f01234';
const chunking = { trainingType: 'chunk', chunkSettingMode: 'auto' } as const;

describe('S4 ingestion contracts', () => {
  it('accepts bounded file imports and rejects duplicate/empty ids at schema boundary', () => {
    expect(
      ImportFilesSchema.parse({
        uploadIds: ['65f1e5b2a1c9d4b7e8f04567'],
        parseProvider: 'liteparse',
        chunking,
      }).parseProvider,
    ).toBe('liteparse');
    expect(ImportFilesSchema.safeParse({ uploadIds: [], chunking }).success).toBe(false);
  });

  it('requires path/body space coherence fields and strict unknown-field rejection', () => {
    expect(
      ImportTextSchema.safeParse({
        knowledgeSpaceId: objectId,
        name: 'Note',
        text: 'body',
        chunking,
        unknown: true,
      }).success,
    ).toBe(false);
  });

  it('accepts only fixed custom API paths', () => {
    const config = {
      provider: 'custom_api',
      baseUrl: 'https://example.com',
      catalogPath: '/v1/file/list',
      detailPath: '/v1/file/detail',
      contentPath: '/v1/file/content',
      previewPath: '/v1/file/read',
      pageMode: 'cursor',
    };
    expect(CustomApiConnectorConfigSchema.safeParse(config).success).toBe(true);
    expect(
      CustomApiConnectorConfigSchema.safeParse({ ...config, catalogPath: '/arbitrary' }).success,
    ).toBe(false);
  });

  it('requires provider identity agreement in connect payloads', () => {
    const result = ConnectorConnectSchema.safeParse({
      provider: 'feishu',
      name: 'Support',
      credentials: { provider: 'feishu', appId: 'id', appSecret: 'secret' },
      config: { provider: 'yuque' },
      syncEnabled: true,
      syncIntervalMinutes: 60,
    });
    expect(result.success).toBe(false);
  });
});
