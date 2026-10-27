import { z } from 'zod';
import { createKnowledgeError } from '@kb/contracts';
import type { OcrCredentialProfilePort, S5OcrProviderName } from '../application/s5-ocr-ports';

const ProfileSchema = z
  .object({
    endpoint: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          (url.protocol === 'https:' || url.protocol === 'http:') &&
          url.username.length === 0 &&
          url.password.length === 0
        );
      }),
    credentials: z.record(z.string(), z.string().min(1)),
  })
  .strict();

type EnvSource = Readonly<Record<string, string | undefined>>;

export class S5OcrCredentialProfileAdapter implements OcrCredentialProfilePort {
  private readonly cache = new Map<string, z.infer<typeof ProfileSchema>>();

  constructor(private readonly env: EnvSource = {}) {}

  async resolve(profileId: string, provider: S5OcrProviderName) {
    if (!profileId.startsWith('env:')) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        requestId: 'ocr-profile',
        traceId: 'ocr-profile',
        details: { field: 'credentialProfileId', reason: 'env_reference_required', provider },
      });
    }
    const cached = this.cache.get(profileId);
    if (cached) return structuredClone(cached);
    const envName = profileId.slice('env:'.length);
    const raw = this.env[envName]?.trim();
    if (!raw) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
        requestId: 'ocr-profile',
        traceId: 'ocr-profile',
        details: { provider, reason: 'credential_profile_missing' },
      });
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        requestId: 'ocr-profile',
        traceId: 'ocr-profile',
        details: { provider, reason: 'credential_profile_invalid_json' },
      });
    }
    const parsed = ProfileSchema.safeParse(json);
    if (!parsed.success) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        requestId: 'ocr-profile',
        traceId: 'ocr-profile',
        details: {
          provider,
          reason: 'credential_profile_invalid',
          fields: parsed.error.issues.map((issue) => issue.path.join('.')),
        },
      });
    }
    this.cache.set(profileId, parsed.data);
    return structuredClone(parsed.data);
  }
}
