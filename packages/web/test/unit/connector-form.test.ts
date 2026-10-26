import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_CREDENTIAL_FIELDS,
  CONNECTOR_PROVIDERS,
} from '../../src/components/connector-form';

describe('S4 connector form contract', () => {
  it('supports all persistent providers and write-only credential fields', () => {
    expect(CONNECTOR_PROVIDERS).toEqual(['feishu', 'yuque', 'dingtalk', 'custom_api']);
    expect(CONNECTOR_CREDENTIAL_FIELDS.feishu).toContain('appSecret');
    expect(CONNECTOR_CREDENTIAL_FIELDS.yuque).toContain('token');
    expect(CONNECTOR_CREDENTIAL_FIELDS.dingtalk).toContain('appSecret');
    expect(CONNECTOR_CREDENTIAL_FIELDS.custom_api).toContain('authorization');
  });

  it('never exposes ciphertext or object storage keys as credential fields', () => {
    const fields = Object.values(CONNECTOR_CREDENTIAL_FIELDS).flat();
    expect(fields).not.toContain('credentialCiphertext');
    expect(fields).not.toContain('objectKey');
  });
});
