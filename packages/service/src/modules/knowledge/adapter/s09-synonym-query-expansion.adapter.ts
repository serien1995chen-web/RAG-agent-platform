import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type { SynonymMapping } from '../domain/s09-synonym';
import type {
  S09MergeExpansions,
  S09QueryExpansionPort,
  S09QueryExpansionResult,
  S09SynonymRepositoryPort,
} from '../application/s09-synonym.ports';

interface CacheEntry {
  fileVersion: number;
  mappings: SynonymMapping[];
  insertedAt: number;
}

export interface S09SynonymQueryExpansionDependencies {
  repository: Pick<
    S09SynonymRepositoryPort,
    'getConfig' | 'getPublishedSnapshot' | 'assertPublishedVersion' | 'getMappingSnapshot'
  >;
  mergeExpansions: S09MergeExpansions;
  now?: () => Date;
  cacheTtlMs?: number;
  cacheCapacity?: number;
}

export class S09SynonymQueryExpansionAdapter implements S09QueryExpansionPort {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly latestVersions = new Map<string, number>();

  constructor(private readonly input: S09SynonymQueryExpansionDependencies) {}

  private now(): number {
    return (this.input.now?.() ?? new Date()).getTime();
  }

  private getCache(key: string): CacheEntry | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    const ttl = this.input.cacheTtlMs ?? 30_000;
    if (nowMinus(this.now(), entry.insertedAt) > ttl) {
      this.cache.delete(key);
      return null;
    }
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry;
  }

  private putCache(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > (this.input.cacheCapacity ?? 100)) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }

  private fallback(
    query: string,
    reason: S09QueryExpansionResult['fallbackReason'],
    audit: {
      spaces: Array<{
        knowledgeSpaceId: string;
        fileVersion: number;
        mappingIds: string[];
      }>;
      cacheHits: number;
      cacheMisses: number;
    },
  ) {
    const [result] = this.input.mergeExpansions({ queries: [query], contexts: [] });
    const fallbackResult: S09QueryExpansionResult = {
      ...(result ?? {
        originalQuery: query,
        expandedQuery: query,
        hits: [],
        normalizedStandardTerms: [],
        appliedMappingIds: [],
        fallbackReason: null,
      }),
      originalQuery: query,
      expandedQuery: query,
      normalizedStandardTerms: [],
      appliedMappingIds: [],
      fallbackReason: reason,
    };
    return {
      result: fallbackResult,
      auditSummary: {
        ...audit,
        fallbackReason: reason,
      },
    };
  }

  async expand(input: { query: string; spaceIds: readonly string[] }, context: TenantContext) {
    const spaceIds = [...new Set(input.spaceIds)];
    const contexts: Array<{
      space: {
        knowledgeSpaceId: string;
        fileVersion: number;
        mappings: SynonymMapping[];
      };
      mappingIds: string[];
    }> = [];
    let cacheHits = 0;
    let cacheMisses = 0;
    for (const spaceId of spaceIds) {
      try {
        const snapshot = await this.input.repository.getPublishedSnapshot(spaceId, context);
        if (!snapshot) {
          try {
            const config = await this.input.repository.getConfig(spaceId, context);
            if (!config.enabled || config.status === 'disabled') {
              return this.fallback(input.query, 'disabled', {
                spaces: [],
                cacheHits,
                cacheMisses,
              });
            }
          } catch (error) {
            const code =
              typeof error === 'object' && error !== null && 'problem' in error
                ? (error as { problem?: { error?: { code?: unknown } } }).problem?.error?.code
                : undefined;
            if (code !== 'KNOWLEDGE_NOT_FOUND') {
              return this.fallback(input.query, 'safety', {
                spaces: [],
                cacheHits,
                cacheMisses,
              });
            }
          }
          continue;
        }
        const versionKey = `${context.workspaceId}:${spaceId}`;
        const previousVersion = this.latestVersions.get(versionKey);
        this.latestVersions.set(versionKey, snapshot.fileVersion);
        if (previousVersion !== undefined && previousVersion !== snapshot.fileVersion) {
          return this.fallback(input.query, 'cache_mismatch', {
            spaces: [],
            cacheHits,
            cacheMisses,
          });
        }
        if (
          !(await this.input.repository.assertPublishedVersion(
            spaceId,
            snapshot.fileVersion,
            context,
          ))
        ) {
          return this.fallback(input.query, 'version_changed', {
            spaces: [],
            cacheHits,
            cacheMisses,
          });
        }
        const key = `${context.workspaceId}:${spaceId}:${snapshot.fileVersion}`;
        const cached = this.getCache(key);
        if (cached && cached.fileVersion === snapshot.fileVersion) {
          cacheHits += 1;
          contexts.push({
            space: {
              knowledgeSpaceId: spaceId,
              fileVersion: snapshot.fileVersion,
              mappings: cached.mappings,
            },
            mappingIds: cached.mappings.map((mapping) => mapping.logicalMappingId),
          });
          continue;
        }
        cacheMisses += 1;
        const mappings = await this.input.repository.getMappingSnapshot(
          spaceId,
          snapshot.fileVersion,
          context,
        );
        if (
          !mappings ||
          !(await this.input.repository.assertPublishedVersion(
            spaceId,
            snapshot.fileVersion,
            context,
          ))
        ) {
          this.cache.delete(key);
          return this.fallback(input.query, 'version_changed', {
            spaces: [],
            cacheHits,
            cacheMisses,
          });
        }
        this.putCache(key, {
          fileVersion: snapshot.fileVersion,
          mappings,
          insertedAt: this.now(),
        });
        contexts.push({
          space: {
            knowledgeSpaceId: spaceId,
            fileVersion: snapshot.fileVersion,
            mappings,
          },
          mappingIds: mappings.map((mapping) => mapping.logicalMappingId),
        });
      } catch {
        return this.fallback(input.query, 'safety', {
          spaces: [],
          cacheHits,
          cacheMisses,
        });
      }
    }
    const [result] = this.input.mergeExpansions({
      queries: [input.query],
      contexts: contexts.map((entry) => ({
        knowledgeSpaceId: entry.space.knowledgeSpaceId,
        fileVersion: entry.space.fileVersion,
        mappings: entry.space.mappings.map((mapping) => ({
          logicalMappingId: mapping.logicalMappingId,
          standardizedTerm: mapping.standardizedTerm,
          normalizedStandardizedTerm: mapping.normalizedStandardizedTerm,
          synonymTerms: mapping.synonymTerms,
          normalizedSynonymTerms: mapping.normalizedSynonymTerms,
        })),
      })),
    });
    const appliedBySpace = new Map<string, Set<string>>();
    for (const hit of result?.hits ?? []) {
      const ids = appliedBySpace.get(hit.knowledgeSpaceId) ?? new Set<string>();
      ids.add(hit.logicalMappingId);
      appliedBySpace.set(hit.knowledgeSpaceId, ids);
    }
    return {
      result: result ?? {
        originalQuery: input.query,
        expandedQuery: input.query,
        hits: [],
        normalizedStandardTerms: [],
        appliedMappingIds: [],
        fallbackReason: null,
      },
      auditSummary: {
        spaces: contexts.map((entry) => ({
          knowledgeSpaceId: entry.space.knowledgeSpaceId,
          fileVersion: entry.space.fileVersion,
          mappingIds: entry.mappingIds.filter((id) =>
            appliedBySpace.get(entry.space.knowledgeSpaceId)?.has(id),
          ),
        })),
        cacheHits,
        cacheMisses,
        fallbackReason: result?.fallbackReason ?? null,
      },
    };
  }
}

function nowMinus(now: number, before: number): number {
  return Math.max(0, now - before);
}
