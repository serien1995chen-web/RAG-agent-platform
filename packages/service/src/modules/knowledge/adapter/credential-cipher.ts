import { createCipheriv, createDecipheriv, randomBytes, type BinaryLike } from 'node:crypto';
import { KnowledgeApiError, createKnowledgeError } from '@kb/contracts';

const ALGORITHM = 'aes-256-gcm';
const ENVELOPE_VERSION = 1;
const KEY_VERSION = 1;

interface CredentialEnvelope {
  v: 1;
  alg: 'A256GCM';
  keyVersion: 1;
  iv: string;
  tag: string;
  data: string;
}

function aadOf(input: {
  workspaceId: string;
  knowledgeSpaceId: string;
  provider: string;
  schemaVersion: number;
}): Buffer {
  return Buffer.from(
    [input.workspaceId, input.knowledgeSpaceId, input.provider, String(input.schemaVersion)].join(
      '|',
    ),
    'utf8',
  );
}

export class KnowledgeCredentialCipher {
  private readonly key: Buffer;

  constructor(key: string | Uint8Array) {
    const material = typeof key === 'string' ? Buffer.from(key, 'utf8') : Buffer.from(key);
    if (material.length < 32) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_PROVIDER_CONFIG_INVALID',
        requestId: 'credential-cipher',
        traceId: 'credential-cipher',
        details: { reason: 'credential_key_too_short', minimumBytes: 32 },
      });
    }
    this.key = material.subarray(0, 32);
  }

  encrypt(
    credentials: Record<string, unknown>,
    input: {
      workspaceId: string;
      knowledgeSpaceId: string;
      provider: string;
      schemaVersion: number;
    },
  ): { ciphertext: string; keyVersion: 1 } {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.key, iv, {
      authTagLength: 16,
    });
    cipher.setAAD(aadOf(input));
    const plaintext = Buffer.from(JSON.stringify(credentials), 'utf8');
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope: CredentialEnvelope = {
      v: ENVELOPE_VERSION,
      alg: 'A256GCM',
      keyVersion: KEY_VERSION,
      iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      data: encrypted.toString('base64url'),
    };
    return { ciphertext: JSON.stringify(envelope), keyVersion: KEY_VERSION };
  }

  decrypt(
    ciphertext: string,
    input: {
      workspaceId: string;
      knowledgeSpaceId: string;
      provider: string;
      schemaVersion: number;
    },
  ): Record<string, unknown> {
    try {
      const envelope = JSON.parse(ciphertext) as CredentialEnvelope;
      if (
        envelope.v !== ENVELOPE_VERSION ||
        envelope.alg !== 'A256GCM' ||
        envelope.keyVersion !== KEY_VERSION
      ) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_PROVIDER_CONFIG_INVALID',
          requestId: 'credential-cipher',
          traceId: 'credential-cipher',
          details: { reason: 'credential_envelope_unsupported' },
        });
      }
      const decipher = createDecipheriv(
        ALGORITHM,
        this.key,
        Buffer.from(envelope.iv, 'base64url'),
        { authTagLength: 16 },
      );
      decipher.setAAD(aadOf(input));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.data, 'base64url')),
        decipher.final(),
      ]);
      const parsed = JSON.parse(plaintext.toString('utf8')) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_PROVIDER_CONFIG_INVALID',
          requestId: 'credential-cipher',
          traceId: 'credential-cipher',
          details: { reason: 'credential_object_required' },
        });
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof KnowledgeApiError) throw error;
      throw createKnowledgeError({
        code: 'KNOWLEDGE_PROVIDER_CONFIG_INVALID',
        requestId: 'credential-cipher',
        traceId: 'credential-cipher',
        details: { reason: 'credential_decryption_failed' },
      });
    }
  }
}

export function isCredentialMaterial(value: BinaryLike): boolean {
  return Buffer.byteLength(value) >= 32;
}
