type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Keeps dynamic OCR credential-profile lookup inside the configuration boundary.
 * Business adapters receive an explicit snapshot rather than reading process.env.
 */
export function loadS5RuntimeEnvironment(env: EnvSource = process.env): EnvSource {
  return Object.freeze({ ...env });
}
