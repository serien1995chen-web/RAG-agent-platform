import { z } from 'zod';
import { ConfigValidationException } from './config-error';
import { resolveSecretRef } from './secret-ref';

const CitationConfigEnvironmentSchema = z.object({
  KB_ENV: z.enum(['development', 'test', 'production']).default('production'),
  KB_CITATION_SIGNING_SECRET_REF: z.string().min(1).default('env:KB_CITATION_SIGNING_SECRET'),
  KB_CITATION_SIGNING_SECRET: z.string().min(32).optional(),
});

export interface S7CitationConfig {
  environment: 'development' | 'test' | 'production';
  citationSigningSecretRef: string;
}

export function loadS7CitationConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): S7CitationConfig {
  const parsed = CitationConfigEnvironmentSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigValidationException(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  if (parsed.data.KB_ENV === 'production') {
    resolveSecretRef(parsed.data.KB_CITATION_SIGNING_SECRET_REF, env);
  }
  return {
    environment: parsed.data.KB_ENV,
    citationSigningSecretRef: parsed.data.KB_CITATION_SIGNING_SECRET_REF,
  };
}
