const QUOTED_FACT = /["'“”‘’]([^"'“”‘’\r\n]{1,128})["'“”‘’]/gu;
const TOKEN_FACT = /\b[A-Za-z0-9][A-Za-z0-9._:/-]*\b/gu;

function normalizedFact(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function isIdentifierFact(value: string): boolean {
  if (/\d/u.test(value)) return true;
  if (/^[A-Z]{2,}$/u.test(value)) return true;
  return /[A-Za-z][._:/-][A-Za-z0-9]/u.test(value);
}

function factsIn(value: string): Set<string> {
  const facts = new Set<string>();
  for (const match of value.matchAll(QUOTED_FACT)) {
    const quoted = normalizedFact(match[1] ?? '');
    if (quoted) facts.add(quoted);
  }
  for (const match of value.matchAll(TOKEN_FACT)) {
    const token = normalizedFact(match[0] ?? '');
    if (token && isIdentifierFact(token)) facts.add(token);
  }
  return facts;
}

/**
 * Reject only deterministic facts that a model must not invent or discard.
 * Ordinary paraphrase and synonym expansion remain available.
 */
export function preservesQueryOptimizationFacts(input: {
  query: string;
  background?: string;
  rewritten: string;
}): boolean {
  const allowed = factsIn(`${input.query}\n${input.background ?? ''}`);
  const required = factsIn(input.query);
  const rewritten = factsIn(input.rewritten);
  if ([...rewritten].some((fact) => !allowed.has(fact))) return false;
  return [...required].every((fact) => rewritten.has(fact));
}
