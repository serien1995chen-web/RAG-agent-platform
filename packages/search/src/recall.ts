import { ApiErrorException, buildIndexVersion, createApiError } from '@kb/contracts';
import type { CitationScore, DegradedInfo, SearchRequest } from '@kb/contracts';
import type { Candidate, RecallOutcome, SearchEngineDeps } from './types';

type ParsedValue = string | null | ParsedValue[] | { [key: string]: ParsedValue };

function invalidCollectionFilter(raw: string): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code: 501050,
      requestId: 'collection-filter',
      params: {
        field: 'collectionFilterMatch',
        value: raw,
        rangeOrVersion: 'tags.$and|tags.$or',
      },
    }),
  );
}

function isRecord(value: ParsedValue): value is { [key: string]: ParsedValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class FrozenJson5Parser {
  private index = 0;

  constructor(private readonly raw: string) {}

  parse(): ParsedValue {
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.raw.length) throw invalidCollectionFilter(this.raw);
    return value;
  }

  private current(): string | undefined {
    return this.raw[this.index];
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.current() ?? '')) this.index += 1;
  }

  private parseValue(): ParsedValue {
    this.skipWhitespace();
    const current = this.current();
    if (current === '{') return this.parseObject();
    if (current === '[') return this.parseArray();
    if (current === "'" || current === '"') return this.parseString();
    if (this.raw.startsWith('null', this.index)) {
      this.index += 4;
      return null;
    }
    throw invalidCollectionFilter(this.raw);
  }

  private parseObject(): { [key: string]: ParsedValue } {
    const output: { [key: string]: ParsedValue } = {};
    this.index += 1;
    this.skipWhitespace();
    while (this.current() !== '}') {
      const key = this.parseKey();
      this.skipWhitespace();
      if (this.current() !== ':') throw invalidCollectionFilter(this.raw);
      this.index += 1;
      output[key] = this.parseValue();
      this.skipWhitespace();
      if (this.current() === ',') {
        this.index += 1;
        this.skipWhitespace();
        if (this.current() === '}') break;
        continue;
      }
      if (this.current() !== '}') throw invalidCollectionFilter(this.raw);
    }
    if (this.current() !== '}') throw invalidCollectionFilter(this.raw);
    this.index += 1;
    return output;
  }

  private parseKey(): string {
    this.skipWhitespace();
    const current = this.current();
    if (current === "'" || current === '"') return this.parseString();
    const start = this.index;
    while (/[A-Za-z0-9_$]/.test(this.current() ?? '')) this.index += 1;
    if (this.index === start) throw invalidCollectionFilter(this.raw);
    return this.raw.slice(start, this.index);
  }

  private parseArray(): ParsedValue[] {
    const output: ParsedValue[] = [];
    this.index += 1;
    this.skipWhitespace();
    while (this.current() !== ']') {
      output.push(this.parseValue());
      this.skipWhitespace();
      if (this.current() === ',') {
        this.index += 1;
        this.skipWhitespace();
        if (this.current() === ']') break;
        continue;
      }
      if (this.current() !== ']') throw invalidCollectionFilter(this.raw);
    }
    if (this.current() !== ']') throw invalidCollectionFilter(this.raw);
    this.index += 1;
    return output;
  }

  private parseString(): string {
    const quote = this.current();
    if (quote !== "'" && quote !== '"') throw invalidCollectionFilter(this.raw);
    this.index += 1;
    let output = '';
    while (this.index < this.raw.length) {
      const current = this.raw[this.index];
      if (current === quote) {
        this.index += 1;
        return output;
      }
      if (current === '\\') {
        const escaped = this.raw[this.index + 1];
        if (escaped === undefined) throw invalidCollectionFilter(this.raw);
        const mapped: Record<string, string> = {
          n: '\n',
          r: '\r',
          t: '\t',
          "'": "'",
          '"': '"',
          '\\': '\\',
        };
        output += mapped[escaped] ?? escaped;
        this.index += 2;
        continue;
      }
      output += current;
      this.index += 1;
    }
    throw invalidCollectionFilter(this.raw);
  }
}

export function parseCollectionFilterMatch(raw: string): {
  matched: boolean;
  tagsAnd: string[];
  tagsOr: string[];
} {
  const parsed = new FrozenJson5Parser(raw).parse();
  if (!isRecord(parsed)) throw invalidCollectionFilter(raw);
  const keys = Object.keys(parsed);
  if (keys.some((key) => key !== 'tags')) throw invalidCollectionFilter(raw);
  if (parsed.tags === undefined) return { matched: true, tagsAnd: [], tagsOr: [] };
  if (!isRecord(parsed.tags)) throw invalidCollectionFilter(raw);

  const tagKeys = Object.keys(parsed.tags);
  if (tagKeys.some((key) => key !== '$and' && key !== '$or')) throw invalidCollectionFilter(raw);

  const readOperator = (value: ParsedValue | undefined, operator: '$and' | '$or'): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw invalidCollectionFilter(raw);
    const output: string[] = [];
    for (const item of value) {
      if (item === null) {
        if (operator === '$and') return [];
        continue;
      }
      if (typeof item !== 'string') throw invalidCollectionFilter(raw);
      output.push(item);
    }
    return output;
  };

  const andValue = parsed.tags.$and;
  const orValue = parsed.tags.$or;
  const tagsAnd = readOperator(andValue, '$and');
  const tagsOr = readOperator(orValue, '$or');
  const matched = !(Array.isArray(andValue) && andValue.some((item) => item === null));
  return { matched, tagsAnd, tagsOr };
}

function vectorCandidate(
  datasetId: string,
  hit: { dataId: string; indexId: string; score: number },
  index: number,
  collectionId: string,
): Candidate {
  const score: CitationScore = { type: 'embedding', value: hit.score, index };
  return {
    docId: `${datasetId}:${hit.dataId}`,
    itemId: hit.dataId,
    collectionId,
    score: hit.score,
    scores: [score],
    text: '',
  };
}

function fullTextCandidate(
  datasetId: string,
  hit: { dataId: string; collectionId: string; score: number },
  index: number,
): Candidate {
  const score: CitationScore = { type: 'fullText', value: hit.score, index };
  return {
    docId: `${datasetId}:${hit.dataId}`,
    itemId: hit.dataId,
    collectionId: hit.collectionId,
    score: hit.score,
    scores: [score],
    text: '',
  };
}

export async function recallCandidates(
  input: SearchRequest,
  deps: SearchEngineDeps,
  context: { requestId: string; tenant: { teamId: string; tmbId: string } },
): Promise<RecallOutcome> {
  const datasetId = input.datasetIds[0] ?? '';
  if (datasetId.length === 0) return { items: [], degraded: [] };

  const options = { timeoutMs: input.budgets?.recallTimeoutMs ?? 5_000 };
  const indexVersion =
    input.versionPolicy?.pinned ?? buildIndexVersion(input.models.embeddingModel, 1536, 'v1');
  const degraded: DegradedInfo[] = [];
  const items: Candidate[] = [];
  const textQueries = input.textQueries.filter((query) => query.trim().length > 0);
  const collectionId = input.collectionIds?.length === 1 ? (input.collectionIds[0] ?? '') : '';

  if (input.imageQueries.length > 0) {
    degraded.push({ stage: 'image', reason: 'image_path_not_configured' });
  }

  const vectorLimit = input.searchMode === 'mixedRecall' ? 80 : 100;
  const fullTextLimit = input.searchMode === 'mixedRecall' ? 60 : 100;

  if (input.searchMode === 'embedding' || input.searchMode === 'mixedRecall') {
    try {
      for (const query of textQueries) {
        const vectors = await deps.embedding.embed(
          { models: input.models, texts: [query], options },
          context,
        );
        const vector = vectors[0];
        if (!vector) continue;
        const hits = await deps.vectors.embRecall(
          {
            teamId: context.tenant.teamId,
            datasetId,
            collectionId: input.collectionIds?.length === 1 ? input.collectionIds[0] : undefined,
            collectionIds: input.collectionIds,
            vector,
            limit: vectorLimit,
            indexVersion,
            options,
          },
          context,
        );
        hits.forEach((hit, index) => {
          items.push(vectorCandidate(datasetId, hit, index, collectionId));
        });
      }
    } catch (error) {
      degraded.push({
        stage: 'vector',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (input.searchMode === 'fullTextRecall' || input.searchMode === 'mixedRecall') {
    if (!deps.fullText) {
      degraded.push({ stage: 'fullText', reason: 'full_text_store_unavailable' });
    } else {
      try {
        for (const query of textQueries) {
          const hits = await deps.fullText.search(
            {
              datasetId,
              collectionIds: input.collectionIds,
              text: query,
              limit: fullTextLimit,
              options,
            },
            context,
          );
          hits.forEach((hit, index) => {
            items.push(fullTextCandidate(datasetId, hit, index));
          });
        }
      } catch (error) {
        degraded.push({
          stage: 'fullText',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return { items, degraded };
}
