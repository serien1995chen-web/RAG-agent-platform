import { createHash } from 'node:crypto';
import { createKnowledgeError } from '@kb/contracts';
import type { TenantContext } from '../../../../shared/persistence/knowledge/tenant';
import type { KnowledgeOperationInput, KnowledgeOperationResult } from '../operation-types';

interface S6SourceView {
  id: string;
  knowledgeSpaceId: string;
  sourceVersion: number;
}

interface S6SegmentView {
  id: string;
  sourceId: string;
  knowledgeSpaceId: string;
  version: number;
}

interface S6CreateSegmentInput {
  question: string;
  answer: string;
  searchEnabled?: boolean;
  metadata?: Record<string, unknown>;
  indexes?: unknown;
}

interface S6CatalogPort {
  getSource(sourceId: string, context: TenantContext): Promise<S6SourceView>;
  getSegment(segmentId: string, context: TenantContext): Promise<S6SegmentView>;
  getSpace(spaceId: string, context: TenantContext): Promise<{ id: string }>;
  updateSegment(
    segmentId: string,
    input: Record<string, unknown>,
    context: TenantContext,
  ): Promise<S6SegmentView>;
  createSegment(
    sourceId: string,
    input: S6CreateSegmentInput,
    context: TenantContext,
  ): Promise<S6SegmentView>;
  deleteSegment(
    segmentId: string,
    context: TenantContext,
    expectedVersion: number,
  ): Promise<Record<string, unknown>>;
}

interface S6AccessPort {
  assertPermission(
    resourceType: 'source' | 'space',
    resourceId: string,
    permission: 'read' | 'write' | 'manage',
    context: TenantContext,
  ): Promise<unknown>;
}

interface S6CreateJobInput {
  kind: 'parse' | 'segment' | 'qa' | 'embed' | 'index' | 'fulltext' | 'rebuild';
  resourceType: 'space' | 'source' | 'segment';
  resourceId: string;
  knowledgeSpaceId: string;
  inputSnapshot: Record<string, unknown>;
  priority: number;
  idempotencyKey: string;
}

interface S6JobPort {
  create(input: S6CreateJobInput, context: TenantContext): Promise<Record<string, unknown>>;
  createSourceRebuild(
    input: S6CreateJobInput & { resourceType: 'source'; sourceVersion: number },
    context: TenantContext,
  ): Promise<Record<string, unknown>>;
  control(
    action: 'retry' | 'cancel' | 'pause' | 'resume' | 'replay',
    jobId: string,
    version: number,
    context: TenantContext,
  ): Promise<Record<string, unknown>>;
}

interface SegmentIndexUpsertInput {
  indexId: string;
  type: 'default' | 'custom' | 'question' | 'summary';
  text: string;
  modelId: string;
  version: number;
}

interface S6SegmentIndexPort {
  createSegment(
    sourceId: string,
    input: {
      question: string;
      answer: string;
      segmentType: 'chunk' | 'qa';
      searchEnabled?: boolean;
      metadata?: Record<string, unknown>;
      indexes?: readonly {
        indexId: string;
        type: 'custom';
        text: string;
        modelId: string;
      }[];
    },
    context: TenantContext,
  ): Promise<{ jobId: string; jobIds: string[] } & Record<string, unknown>>;
  upsert(
    segmentId: string,
    input: SegmentIndexUpsertInput,
    mode: 'create' | 'update',
    context: TenantContext,
  ): Promise<unknown>;
  remove(
    segmentId: string,
    indexId: string,
    expectedVersion: number,
    context: TenantContext,
  ): Promise<unknown>;
  reindex(
    segmentId: string,
    input: {
      reason: 'manual' | 'model_change' | 'synonym_change' | 'repair';
      modelId?: string;
      version: number;
    },
    context: TenantContext,
  ): Promise<{ jobId: string } & Record<string, unknown>>;
  history(segmentId: string, context: TenantContext): Promise<unknown>;
}

export const S06_OPERATION_IDS = Object.freeze([
  'API-SEGMENT-CREATE',
  'API-JOB-CREATE',
  'API-JOB-RETRY',
  'API-JOB-CANCEL',
  'API-JOB-PAUSE',
  'API-JOB-RESUME',
  'API-JOB-REPLAY',
  'API-SEGMENT-BATCH',
  'API-SEGMENT-INDEX-CREATE',
  'API-SEGMENT-INDEX-UPDATE',
  'API-SEGMENT-INDEX-DELETE',
  'API-SEGMENT-HISTORY',
  'API-SEGMENT-REINDEX',
] as const);

const S06_OPERATION_SET = new Set<string>(S06_OPERATION_IDS);
const JOB_KINDS = ['parse', 'segment', 'qa', 'embed', 'index', 'fulltext', 'rebuild'] as const;
const JOB_RESOURCE: Record<
  (typeof JOB_KINDS)[number],
  readonly ('source' | 'segment' | 'space')[]
> = {
  parse: ['source'],
  segment: ['segment'],
  qa: ['segment'],
  embed: ['segment'],
  index: ['segment'],
  fulltext: ['segment'],
  rebuild: ['source', 'space'],
};

const SEGMENT_INDEX_KEYS = ['indexId', 'type', 'text', 'modelId'] as const;

function normalizeSegmentType(
  value: unknown,
  answer: string,
  context: TenantContext,
): 'chunk' | 'qa' {
  if (value !== undefined && value !== 'chunk' && value !== 'qa') {
    throw validation(context, { field: 'segmentType', allowed: ['chunk', 'qa'] });
  }
  return (value as 'chunk' | 'qa' | undefined) ?? (answer.trim() ? 'qa' : 'chunk');
}

function normalizeIndexes(value: unknown, context: TenantContext) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw validation(context, { field: 'indexes', maxItems: 100 });
  }
  const seen = new Set<string>();
  return value.map((raw, index) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw validation(context, { field: `indexes[${index}]`, reason: 'object_required' });
    }
    const candidate = raw as Record<string, unknown>;
    assertKeys(candidate, SEGMENT_INDEX_KEYS, [], context);
    if (candidate.type !== 'custom') {
      throw validation(context, { field: `indexes[${index}].type`, allowed: ['custom'] });
    }
    const indexId = String(candidate.indexId ?? '');
    if (seen.has(indexId)) {
      throw validation(context, { field: `indexes[${index}].indexId`, reason: 'unique' });
    }
    seen.add(indexId);
    const text = String(candidate.text ?? '').trim();
    const modelId = String(candidate.modelId ?? '');
    if (!text) throw validation(context, { field: `indexes[${index}].text`, reason: 'required' });
    if (!modelId) {
      throw validation(context, { field: `indexes[${index}].modelId`, reason: 'required' });
    }
    return {
      indexId,
      type: 'custom' as const,
      text,
      modelId,
    };
  });
}

function normalizeSegmentCreate(body: Record<string, unknown>, context: TenantContext) {
  assertKeys(
    body,
    ['question'],
    ['answer', 'segmentType', 'searchEnabled', 'metadata', 'indexes'],
    context,
  );
  const question = String(body.question ?? '').trim();
  const answer = String(body.answer ?? '').trim();
  if (!question) throw validation(context, { field: 'question', reason: 'required' });
  if (question.length > 100_000) {
    throw validation(context, { field: 'question', maxLength: 100_000 });
  }
  if (answer.length > 100_000) {
    throw validation(context, { field: 'answer', maxLength: 100_000 });
  }
  const segmentType = normalizeSegmentType(body.segmentType, answer, context);
  if (segmentType === 'qa' && !answer) {
    throw validation(context, { field: 'answer', reason: 'required', segmentType });
  }
  const storedAnswer = segmentType === 'chunk' && !answer ? question : answer;
  if (body.searchEnabled !== undefined && typeof body.searchEnabled !== 'boolean') {
    throw validation(context, { field: 'searchEnabled', reason: 'boolean_required' });
  }
  if (
    body.metadata !== undefined &&
    (typeof body.metadata !== 'object' || body.metadata === null || Array.isArray(body.metadata))
  ) {
    throw validation(context, { field: 'metadata', reason: 'object_required' });
  }
  return {
    question,
    answer: storedAnswer,
    segmentType,
    ...(typeof body.searchEnabled === 'boolean' ? { searchEnabled: body.searchEnabled } : {}),
    ...(body.metadata ? { metadata: body.metadata as Record<string, unknown> } : {}),
    indexes: normalizeIndexes(body.indexes, context),
  };
}

export function isS06Operation(operationId: string): boolean {
  return S06_OPERATION_SET.has(operationId);
}

function validation(context: TenantContext, details: Record<string, unknown>) {
  return createKnowledgeError({
    code: 'KNOWLEDGE_VALIDATION_FAILED',
    requestId: context.requestId,
    traceId: context.traceId,
    details,
  });
}

function bodyObject(value: unknown, context: TenantContext): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw validation(context, { field: 'body', reason: 'object_required' });
  }
  return value as Record<string, unknown>;
}

function assertKeys(
  body: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  context: TenantContext,
) {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw validation(context, { fields: unknown, reason: 'unknown_fields' });
  const missing = required.filter((key) => body[key] === undefined);
  if (missing.length > 0) throw validation(context, { fields: missing, reason: 'required' });
}

function versionOf(body: Record<string, unknown>, context: TenantContext): number {
  assertKeys(body, ['version'], [], context);
  const version = Number(body.version);
  if (!Number.isInteger(version) || version < 1) {
    throw validation(context, { field: 'version', min: 1 });
  }
  return version;
}

function idempotencyKey(input: KnowledgeOperationInput, context: TenantContext): string {
  const value = input.headers?.['idempotency-key'];
  const key = Array.isArray(value) ? value[0] : value;
  if (!key || key.length < 16 || key.length > 128) {
    throw validation(context, { header: 'Idempotency-Key', reason: 'required_16_128' });
  }
  return key;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function validateSnapshot(
  kind: (typeof JOB_KINDS)[number],
  snapshot: Record<string, unknown>,
  resourceType: 'source' | 'segment' | 'space',
  context: TenantContext,
) {
  if (Object.hasOwn(snapshot, 'workspaceId')) {
    throw validation(context, { field: 'inputSnapshot.workspaceId', reason: 'forbidden' });
  }
  if (kind === 'rebuild') {
    if (resourceType === 'space') {
      assertKeys(snapshot, ['sourceIds', 'reason'], ['targetModelId'], context);
      if (!Array.isArray(snapshot.sourceIds) || snapshot.sourceIds.length === 0) {
        throw validation(context, { field: 'inputSnapshot.sourceIds', min: 1 });
      }
      return;
    }
    assertKeys(
      snapshot,
      ['sourceId', 'sourceVersion', 'reason', 'expectedSegmentVersions'],
      ['targetModelId'],
      context,
    );
    if (!Array.isArray(snapshot.expectedSegmentVersions)) {
      throw validation(context, { field: 'inputSnapshot.expectedSegmentVersions' });
    }
    return;
  }
  if (kind === 'parse') {
    assertKeys(
      snapshot,
      ['sourceVersion', 'parseProvider', 'configHash', 'chunking'],
      ['blobRefId'],
      context,
    );
    return;
  }
  if (kind === 'segment') {
    assertKeys(snapshot, ['rawTextBlobId', 'sourceVersion', 'chunking'], [], context);
    return;
  }
  if (kind === 'qa') {
    assertKeys(
      snapshot,
      ['segmentInputs', 'modelId', 'promptVersion', 'sourceVersion'],
      [],
      context,
    );
    return;
  }
  if (kind === 'embed' || kind === 'index' || kind === 'fulltext') {
    assertKeys(snapshot, ['segmentVersion'], ['modelId', 'indexId'], context);
  }
}

export class S06JobApplication {
  constructor(
    private readonly jobs: S6JobPort,
    private readonly segmentIndexes: S6SegmentIndexPort,
    private readonly catalog: S6CatalogPort,
    private readonly access: S6AccessPort,
  ) {}

  private async createSegment(input: KnowledgeOperationInput): Promise<KnowledgeOperationResult> {
    const sourceId = String(input.params.sourceId ?? '');
    await this.access.assertPermission('source', sourceId, 'write', input.context);
    const parsed = normalizeSegmentCreate(bodyObject(input.body, input.context), input.context);
    return {
      status: 201,
      data: await this.segmentIndexes.createSegment(sourceId, parsed, input.context),
    };
  }

  private async createJob(input: KnowledgeOperationInput): Promise<KnowledgeOperationResult> {
    const context = input.context;
    const body = bodyObject(input.body, context);
    assertKeys(
      body,
      ['kind', 'resourceType', 'resourceId', 'inputSnapshot'],
      ['priority'],
      context,
    );
    const kind = String(body.kind) as (typeof JOB_KINDS)[number];
    if (!JOB_KINDS.includes(kind)) {
      throw validation(context, { field: 'kind', allowed: JOB_KINDS });
    }
    const resourceType = String(body.resourceType) as 'source' | 'segment' | 'space';
    if (!JOB_RESOURCE[kind].includes(resourceType)) {
      throw validation(context, {
        field: 'resourceType',
        expected: JOB_RESOURCE[kind],
        actual: resourceType,
      });
    }
    if (!/^[a-f0-9]{24}$/.test(String(body.resourceId))) {
      throw validation(context, { field: 'resourceId' });
    }
    const snapshot = bodyObject(body.inputSnapshot, context);
    validateSnapshot(kind, snapshot, resourceType, context);
    const priority = body.priority === undefined ? 5 : Number(body.priority);
    if (!Number.isInteger(priority) || priority < 0 || priority > 9) {
      throw validation(context, { field: 'priority', min: 0, max: 9 });
    }
    const resourceId = String(body.resourceId);
    let knowledgeSpaceId: string;
    let sourceVersion: number | undefined;
    if (resourceType === 'source') {
      const source = await this.catalog.getSource(resourceId, context);
      await this.access.assertPermission('source', resourceId, 'write', context);
      knowledgeSpaceId = String(source.knowledgeSpaceId);
      sourceVersion = Number(source.sourceVersion);
      if (kind === 'rebuild' && Number(snapshot.sourceVersion) !== Number(source.sourceVersion)) {
        throw validation(context, {
          field: 'inputSnapshot.sourceVersion',
          reason: 'source_version_mismatch',
        });
      }
      if (snapshot.sourceId && String(snapshot.sourceId) !== resourceId) {
        throw validation(context, { field: 'inputSnapshot.sourceId', reason: 'resource_mismatch' });
      }
    } else if (resourceType === 'segment') {
      const segment = await this.catalog.getSegment(resourceId, context);
      await this.access.assertPermission('source', segment.sourceId, 'write', context);
      knowledgeSpaceId = String(segment.knowledgeSpaceId);
    } else {
      const space = await this.catalog.getSpace(resourceId, context);
      await this.access.assertPermission('space', resourceId, 'write', context);
      knowledgeSpaceId = String(space.id);
      const sourceIds = Array.isArray(snapshot.sourceIds)
        ? [...new Set(snapshot.sourceIds.map(String))]
        : [];
      if (
        sourceIds.length !== (Array.isArray(snapshot.sourceIds) ? snapshot.sourceIds.length : 0)
      ) {
        throw validation(context, {
          field: 'inputSnapshot.sourceIds',
          reason: 'unique',
        });
      }
      for (const sourceId of sourceIds) {
        if (!/^[a-f0-9]{24}$/.test(sourceId)) {
          throw validation(context, { field: 'inputSnapshot.sourceIds', reason: 'object_id' });
        }
        const source = await this.catalog.getSource(sourceId, context);
        if (source.knowledgeSpaceId !== knowledgeSpaceId) {
          throw validation(context, {
            field: 'inputSnapshot.sourceIds',
            reason: 'space_mismatch',
            sourceId,
          });
        }
        await this.access.assertPermission('source', sourceId, 'write', context);
      }
    }
    const requestHash = hash({
      kind,
      resourceType,
      resourceId,
      inputSnapshot: snapshot,
    });
    const jobInput: S6CreateJobInput = {
      kind,
      resourceType,
      resourceId,
      knowledgeSpaceId,
      inputSnapshot: { ...snapshot, requestHash },
      priority,
      idempotencyKey: idempotencyKey(input, context),
    };
    const job =
      kind === 'rebuild' && resourceType === 'source'
        ? await this.jobs.createSourceRebuild(
            { ...jobInput, resourceType: 'source', sourceVersion: sourceVersion! },
            context,
          )
        : await this.jobs.create(jobInput, context);
    return { status: 202, data: job };
  }

  private async command(
    action: 'retry' | 'cancel' | 'pause' | 'resume' | 'replay',
    input: KnowledgeOperationInput,
  ): Promise<KnowledgeOperationResult> {
    if (
      action === 'replay' &&
      !input.context.isWorkspaceOwner &&
      !input.context.scopes.includes('knowledge:admin')
    ) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_FORBIDDEN',
        requestId: input.context.requestId,
        traceId: input.context.traceId,
        details: { reason: 'admin_required' },
      });
    }
    const version = versionOf(bodyObject(input.body, input.context), input.context);
    const job = await this.jobs.control(action, input.params.jobId ?? '', version, input.context);
    return { status: 200, data: job };
  }

  private async upsertIndex(
    mode: 'create' | 'update',
    input: KnowledgeOperationInput,
  ): Promise<KnowledgeOperationResult> {
    const body = bodyObject(input.body, input.context);
    assertKeys(body, ['indexId', 'type', 'text', 'modelId', 'version'], [], input.context);
    if (mode === 'update' && String(input.params.indexId ?? '') !== String(body.indexId ?? '')) {
      throw validation(input.context, {
        field: 'indexId',
        reason: 'path_body_mismatch',
      });
    }
    const segment = await this.catalog.getSegment(input.params.segmentId ?? '', input.context);
    await this.access.assertPermission('source', segment.sourceId, 'write', input.context);
    const data = await this.segmentIndexes.upsert(
      segment.id,
      body as unknown as SegmentIndexUpsertInput,
      mode,
      input.context,
    );
    return { status: mode === 'create' ? 201 : 200, data };
  }

  private async batch(input: KnowledgeOperationInput): Promise<KnowledgeOperationResult> {
    const body = bodyObject(input.body, input.context);
    assertKeys(body, ['action', 'items'], [], input.context);
    const action = String(body.action);
    if (!['upsert', 'delete', 'reindex'].includes(action)) {
      throw validation(input.context, { field: 'action' });
    }
    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length < 1 || items.length > 200) {
      throw validation(input.context, { field: 'items', min: 1, max: 200 });
    }
    const records = items.map((raw, index) => {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw validation(input.context, { field: `items[${index}]`, reason: 'object_required' });
      }
      return raw as Record<string, unknown>;
    });
    for (const [index, item] of records.entries()) {
      if (action === 'upsert') {
        if (item.id) {
          assertKeys(
            item,
            ['id', 'version'],
            ['question', 'answer', 'segmentType', 'metadata', 'searchEnabled'],
            input.context,
          );
          if (item.question !== undefined && !String(item.question).trim()) {
            throw validation(input.context, {
              field: `items[${index}].question`,
              reason: 'required',
            });
          }
          if (
            item.segmentType === 'qa' &&
            item.answer !== undefined &&
            !String(item.answer).trim()
          ) {
            throw validation(input.context, {
              field: `items[${index}].answer`,
              reason: 'required',
              segmentType: 'qa',
            });
          }
          if (
            item.segmentType !== undefined &&
            item.segmentType !== 'chunk' &&
            item.segmentType !== 'qa'
          ) {
            throw validation(input.context, {
              field: `items[${index}].segmentType`,
              allowed: ['chunk', 'qa'],
            });
          }
        } else {
          const { sourceId: rawSourceId, ...createBody } = item;
          const sourceId = String(rawSourceId ?? '');
          normalizeSegmentCreate(createBody, input.context);
          if (!/^[a-f0-9]{24}$/.test(sourceId)) {
            throw validation(input.context, { field: `items[${index}].sourceId` });
          }
        }
        const sourceId = item.id ? null : String(item.sourceId ?? '');
        if (!item.id && !/^[a-f0-9]{24}$/.test(sourceId ?? '')) {
          throw validation(input.context, { field: `items[${index}].sourceId` });
        }
        if (item.id) {
          const segment = await this.catalog.getSegment(String(item.id), input.context);
          await this.access.assertPermission('source', segment.sourceId, 'write', input.context);
        } else {
          await this.catalog.getSource(sourceId!, input.context);
          await this.access.assertPermission('source', sourceId!, 'write', input.context);
        }
      } else {
        assertKeys(
          item,
          ['version'],
          action === 'reindex' ? ['id', 'segmentId', 'reason', 'modelId'] : ['id', 'segmentId'],
          input.context,
        );
        if (!item.id && !item.segmentId) {
          throw validation(input.context, {
            field: `items[${index}].id`,
            reason: 'required',
          });
        }
        const segment = await this.catalog.getSegment(
          String(item.id ?? item.segmentId ?? ''),
          input.context,
        );
        await this.access.assertPermission(
          'source',
          segment.sourceId,
          action === 'delete' ? 'manage' : 'write',
          input.context,
        );
      }
    }
    const results: Array<Record<string, unknown>> = [];
    for (const [index, item] of records.entries()) {
      const id = String(item.id ?? item.segmentId ?? '');
      const version = Number(item.version);
      try {
        if (action === 'upsert') {
          if (item.id) {
            const segment = await this.catalog.updateSegment(
              id,
              {
                question: item.question,
                answer: item.answer,
                metadata: item.metadata,
                searchEnabled: item.searchEnabled,
                version: item.version,
              },
              input.context,
            );
            const indexed = await this.segmentIndexes.reindex(
              id,
              { reason: 'manual', version: segment.version },
              input.context,
            );
            const latest = await this.catalog.getSegment(id, input.context);
            results.push({
              index,
              id,
              success: true,
              version: Number(latest.version),
              jobId: indexed.jobId,
            });
          } else {
            const { sourceId, ...createBody } = item;
            const segment = await this.segmentIndexes.createSegment(
              String(sourceId),
              normalizeSegmentCreate(createBody, input.context),
              input.context,
            );
            results.push({
              index,
              id: String(segment.id),
              success: true,
              version: Number(segment.version),
              jobIds: segment.jobIds,
            });
          }
        } else if (action === 'delete') {
          if (!Number.isInteger(version) || version < 1) {
            throw validation(input.context, { field: `items[${index}].version` });
          }
          await this.catalog.deleteSegment(id, input.context, version);
          results.push({ index, id, success: true });
        } else {
          const result = await this.segmentIndexes.reindex(
            id,
            {
              reason: (item.reason as 'manual') ?? 'manual',
              ...(typeof item.modelId === 'string' ? { modelId: item.modelId } : {}),
              version: Number(item.version),
            },
            input.context,
          );
          results.push({ index, id, success: true, jobId: result.jobId });
        }
      } catch (error) {
        results.push({
          index,
          id: id || `items[${index}]`,
          success: false,
          code:
            typeof error === 'object' &&
            error !== null &&
            'problem' in error &&
            typeof (error as { problem?: { error?: { code?: unknown } } }).problem?.error?.code ===
              'string'
              ? String((error as { problem: { error: { code: string } } }).problem.error.code)
              : 'KNOWLEDGE_INTERNAL_ERROR',
        });
      }
    }
    const succeeded = results.filter((item) => item.success === true).length;
    return {
      status: succeeded === results.length ? 200 : 207,
      data: {
        ...(succeeded === results.length ? {} : { code: 'KNOWLEDGE_PARTIAL_SUCCESS' }),
        requested: results.length,
        succeeded,
        failed: results.length - succeeded,
        items: results,
      },
    };
  }

  async dispatch(input: KnowledgeOperationInput): Promise<KnowledgeOperationResult> {
    switch (input.operationId) {
      case 'API-SEGMENT-CREATE':
        return this.createSegment(input);
      case 'API-JOB-CREATE':
        return this.createJob(input);
      case 'API-JOB-RETRY':
        return this.command('retry', input);
      case 'API-JOB-CANCEL':
        return this.command('cancel', input);
      case 'API-JOB-PAUSE':
        return this.command('pause', input);
      case 'API-JOB-RESUME':
        return this.command('resume', input);
      case 'API-JOB-REPLAY':
        return this.command('replay', input);
      case 'API-SEGMENT-BATCH':
        return this.batch(input);
      case 'API-SEGMENT-INDEX-CREATE':
        return this.upsertIndex('create', input);
      case 'API-SEGMENT-INDEX-UPDATE':
        return this.upsertIndex('update', input);
      case 'API-SEGMENT-INDEX-DELETE': {
        const version = versionOf(bodyObject(input.body, input.context), input.context);
        const segment = await this.catalog.getSegment(input.params.segmentId ?? '', input.context);
        await this.access.assertPermission('source', segment.sourceId, 'write', input.context);
        const data = await this.segmentIndexes.remove(
          segment.id,
          input.params.indexId ?? '',
          version,
          input.context,
        );
        return { status: 202, data };
      }
      case 'API-SEGMENT-HISTORY': {
        const segment = await this.catalog.getSegment(input.params.segmentId ?? '', input.context);
        await this.access.assertPermission('source', segment.sourceId, 'read', input.context);
        return {
          status: 200,
          data: await this.segmentIndexes.history(segment.id, input.context),
        };
      }
      case 'API-SEGMENT-REINDEX': {
        const body = bodyObject(input.body, input.context);
        assertKeys(body, ['reason', 'version'], ['modelId'], input.context);
        const segment = await this.catalog.getSegment(input.params.segmentId ?? '', input.context);
        await this.access.assertPermission('source', segment.sourceId, 'write', input.context);
        return {
          status: 202,
          data: await this.segmentIndexes.reindex(
            segment.id,
            {
              reason: body.reason as 'manual',
              ...(typeof body.modelId === 'string' ? { modelId: body.modelId } : {}),
              version: Number(body.version),
            },
            input.context,
          ),
        };
      }
      default:
        throw createKnowledgeError({
          code: 'KNOWLEDGE_INTERNAL_ERROR',
          requestId: input.context.requestId,
          traceId: input.context.traceId,
          details: { operationId: input.operationId, reason: 'not_s06_operation' },
        });
    }
  }
}
