import { describe, expect, it } from 'vitest';
import {
  ConnectorConnectSchema,
  CustomApiConnectorConfigSchema,
  ImportFilesSchema,
  ImportImageDatasetSchema,
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

  it('requires exactly one upload for file dry-run previews', () => {
    expect(
      ImportFilesSchema.safeParse({
        uploadIds: ['upl-preview'],
        chunking,
        dryRun: true,
      }).success,
    ).toBe(true);
    expect(
      ImportFilesSchema.safeParse({
        uploadIds: ['upl-1', 'upl-2'],
        chunking,
        dryRun: true,
      }).success,
    ).toBe(false);
  });

  it('accepts a named image collection of at most five uploads', () => {
    expect(
      ImportImageDatasetSchema.parse({
        name: '产品截图',
        uploadIds: ['upl-1', 'upl-2'],
      }).chunking,
    ).toEqual({ trainingType: 'imageParse', chunkSettingMode: 'auto' });
    expect(
      ImportImageDatasetSchema.safeParse({
        name: 'too-many',
        uploadIds: ['1', '2', '3', '4', '5', '6'],
      }).success,
    ).toBe(false);
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
