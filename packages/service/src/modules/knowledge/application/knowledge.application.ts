import { createHash } from 'node:crypto';
import { createKnowledgeError } from '@kb/contracts';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import { assertBatchVersions, type AclResourceType, type PermissionLevel } from '../domain';
import type {
  AccessPort,
  AuditPort,
  CatalogPort,
  JobPort,
  ReferencePort,
  SourceView,
  TagPort,
} from './ports';
import type { FileApplication } from './file.application';
import type { SourceFileApplication } from './source-preview';
import { isS06Operation } from './operations/s06-jobs';
import type { KnowledgeOperationInput, KnowledgeOperationResult } from './operation-types';

export type { KnowledgeOperationInput, KnowledgeOperationResult } from './operation-types';

interface S5OperationApplication {
  dispatch(input: KnowledgeOperationInput): Promise<KnowledgeOperationResult>;
}

interface S6OperationApplication {
  dispatch(input: KnowledgeOperationInput): Promise<KnowledgeOperationResult>;
}

function objectBody(value: unknown, context: TenantContext): Record<string, unknown> {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { field: 'body', reason: 'object_required' },
    });
  }
  return value as Record<string, unknown>;
}

function firstQuery(
  query: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | undefined {
  const value = query[name];
  return Array.isArray(value) ? value[0] : value;
}

function pageQuery(query: KnowledgeOperationInput['query']) {
  return {
    cursor: firstQuery(query, 'cursor'),
    limit: firstQuery(query, 'limit'),
    sort: firstQuery(query, 'sort'),
    kind: firstQuery(query, 'kind'),
    status: firstQuery(query, 'status'),
  };
}

function resourceTypeOf(value: string | undefined, context: TenantContext): AclResourceType {
  if (value === 'space' || value === 'directory' || value === 'source') return value;
  throw createKnowledgeError({
    code: 'KNOWLEDGE_VALIDATION_FAILED',
    requestId: context.requestId,
    traceId: context.traceId,
    details: { field: 'resourceType' },
  });
}

export class KnowledgeApplication {
  constructor(
    private readonly catalog: CatalogPort,
    private readonly tags: TagPort,
    private readonly access: AccessPort,
    private readonly jobs: JobPort,
    private readonly files?: FileApplication,
    private readonly sources?: SourceFileApplication,
    private readonly references?: ReferencePort,
    private readonly audits?: AuditPort,
    private readonly s5Models?: S5OperationApplication,
    private readonly s5ModelBindings?: S5OperationApplication,
    private readonly s06?: S6OperationApplication,
  ) {}

  private async requireExistingPermission(
    resourceType: AclResourceType,
    resourceId: string,
    required: PermissionLevel,
    context: TenantContext,
  ): Promise<void> {
    if (resourceType === 'space') await this.catalog.getSpace(resourceId, context);
    else if (resourceType === 'directory') await this.catalog.getDirectory(resourceId, context);
    else await this.catalog.getSource(resourceId, context);
    try {
      await this.access.assertPermission(resourceType, resourceId, required, context);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'problem' in error &&
        (error as { problem?: { error?: { code?: string } } }).problem?.error?.code ===
          'KNOWLEDGE_NOT_FOUND'
      ) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_FORBIDDEN',
          requestId: context.requestId,
          traceId: context.traceId,
          details: { resourceType },
        });
      }
      throw error;
    }
  }

  private normalizeBatchIds(value: unknown, context: TenantContext): string[] {
    const raw = Array.isArray(value) ? value.map(String) : [];
    const ids = [...new Set(raw)];
    if (ids.length < 1 || ids.length > 100 || ids.length !== raw.length) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { field: 'ids', min: 1, max: 100, unique: true },
      });
    }
    return ids;
  }

  private itemCode(error: unknown): string {
    if (
      typeof error === 'object' &&
      error !== null &&
      'problem' in error &&
      typeof (error as { problem?: { error?: { code?: unknown } } }).problem?.error?.code ===
        'string'
    ) {
      return String((error as { problem: { error: { code: string } } }).problem.error.code);
    }
    return 'KNOWLEDGE_INTERNAL_ERROR';
  }

  private async failedBatchItem(
    input: {
      id: string;
      action: 'move' | 'delete';
      resourceType: 'space' | 'source';
      knowledgeSpaceId: string | null;
    },
    error: unknown,
    context: TenantContext,
  ): Promise<Record<string, unknown>> {
    const failureCode = this.itemCode(error);
    if (!this.audits) {
      return { id: input.id, success: false, code: 'KNOWLEDGE_INTERNAL_ERROR' };
    }
    try {
      await this.audits.appendStandalone(
        {
          knowledgeSpaceId: input.resourceType === 'space' ? input.id : input.knowledgeSpaceId,
          action: `batch.${input.resourceType}.failed`,
          resourceType: input.resourceType,
          resourceId: input.id,
          outcome: 'failed',
          safeDiff: { action: input.action, failureCode },
        },
        context,
      );
    } catch {
      return { id: input.id, success: false, code: 'KNOWLEDGE_INTERNAL_ERROR' };
    }
    return { id: input.id, success: false, code: failureCode };
  }

  async dispatch(input: KnowledgeOperationInput): Promise<KnowledgeOperationResult> {
    const { context, params } = input;
    if (isS06Operation(input.operationId)) {
      if (!this.s06) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_INTERNAL_ERROR',
          requestId: context.requestId,
          traceId: context.traceId,
          details: { operationId: input.operationId, reason: 's06_application_missing' },
        });
      }
      return this.s06.dispatch(input);
    }
    if (
      input.operationId === 'API-MODEL-LIST' ||
      input.operationId === 'API-MODEL-BINDING-VALIDATE'
    ) {
      if (!this.s5Models) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_INTERNAL_ERROR',
          requestId: context.requestId,
          traceId: context.traceId,
          details: { operationId: input.operationId, reason: 's5_model_application_missing' },
        });
      }
      return this.s5Models.dispatch(input);
    }
    if (
      input.operationId === 'API-MODEL-BINDING-GET' ||
      input.operationId === 'API-MODEL-BINDING-UPDATE'
    ) {
      if (!this.s5ModelBindings) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_INTERNAL_ERROR',
          requestId: context.requestId,
          traceId: context.traceId,
          details: {
            operationId: input.operationId,
            reason: 's5_model_binding_application_missing',
          },
        });
      }
      return this.s5ModelBindings.dispatch(input);
    }
    const body = input.operationId === 'API-UPLOAD-PART' ? {} : objectBody(input.body, context);
    switch (input.operationId) {
      case 'API-SPACE-LIST': {
        const page = await this.catalog.listSpaces(pageQuery(input.query), context);
        const visible = [];
        for (const item of page.items) {
          try {
            await this.access.assertPermission('space', item.id, 'read', context);
            visible.push(item);
          } catch {
            // Cross-resource ACL is a visibility filter, not a partial-success result.
          }
        }
        return { status: 200, data: { items: visible, pageInfo: page.pageInfo } };
      }
      case 'API-SPACE-CREATE': {
        const created = await this.catalog.createSpace(
          {
            kind: body.kind as 'space' | 'folder',
            parentSpaceId: (body.parentSpaceId as string | null | undefined) ?? null,
            name: String(body.name ?? ''),
            description: typeof body.description === 'string' ? body.description : '',
            iconKey: typeof body.iconKey === 'string' ? body.iconKey : 'book-open',
            accessMode: body.accessMode as 'workspace' | 'restricted',
            sourceAclMode: body.sourceAclMode as 'inherited' | 'enforced',
            sourcePermissionEnabled:
              typeof body.sourcePermissionEnabled === 'boolean'
                ? body.sourcePermissionEnabled
                : true,
          },
          context,
        );
        await this.access.ensureOwnerAcl('space', created.id, context, [
          ...(created.accessMode === 'workspace'
            ? [
                {
                  principalType: 'workspace' as const,
                  principalId: context.workspaceId,
                  permission: 'read' as const,
                },
              ]
            : []),
        ]);
        return { status: 201, data: created };
      }
      case 'API-SPACE-GET': {
        await this.access.assertPermission('space', params.spaceId ?? '', 'read', context);
        return { status: 200, data: await this.catalog.getSpace(params.spaceId ?? '', context) };
      }
      case 'API-SPACE-REFERENCES': {
        await this.requireExistingPermission('space', params.spaceId ?? '', 'read', context);
        if (!this.references) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_INTERNAL_ERROR',
            requestId: context.requestId,
            traceId: context.traceId,
            details: { reason: 'reference_port_missing' },
          });
        }
        return {
          status: 200,
          data: await this.references.list(params.spaceId ?? '', context),
        };
      }
      case 'API-SPACE-UPDATE': {
        await this.access.assertPermission('space', params.spaceId ?? '', 'write', context);
        return {
          status: 200,
          data: await this.catalog.updateSpace(params.spaceId ?? '', body, context),
        };
      }
      case 'API-SPACE-DELETE': {
        await this.access.assertPermission('space', params.spaceId ?? '', 'manage', context);
        return {
          status: 202,
          data: await this.catalog.deleteSpace(params.spaceId ?? '', body, context),
        };
      }
      case 'API-SPACE-MOVE': {
        await this.requireExistingPermission('space', params.spaceId ?? '', 'write', context);
        if (body.targetParentId && typeof body.targetParentId === 'string') {
          await this.requireExistingPermission('space', body.targetParentId, 'write', context);
        }
        return {
          status: 200,
          data: await this.catalog.moveSpace(params.spaceId ?? '', body, context),
        };
      }
      case 'API-SPACE-BATCH': {
        const ids = this.normalizeBatchIds(body.ids, context);
        const versions = assertBatchVersions(ids, body.versions, context);
        const action = String(body.action ?? '');
        if (action !== 'move' && action !== 'delete') {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_VALIDATION_FAILED',
            requestId: context.requestId,
            traceId: context.traceId,
            details: { field: 'action' },
          });
        }
        if (action === 'move' && !Object.hasOwn(body, 'targetParentId')) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_VALIDATION_FAILED',
            requestId: context.requestId,
            traceId: context.traceId,
            details: { field: 'targetParentId', reason: 'required_for_move' },
          });
        }
        if (action === 'delete' && body.targetParentId != null) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_VALIDATION_FAILED',
            requestId: context.requestId,
            traceId: context.traceId,
            details: { field: 'targetParentId', reason: 'not_allowed_for_delete' },
          });
        }
        if (action === 'move' && body.targetParentId != null) {
          await this.requireExistingPermission(
            'space',
            String(body.targetParentId),
            'write',
            context,
          );
        }
        const items: Array<Record<string, unknown>> = [];
        let succeeded = 0;
        for (const id of ids) {
          try {
            await this.requireExistingPermission('space', id, 'manage', context);
            const current = await this.catalog.getSpace(id, context);
            const data =
              action === 'move'
                ? await this.catalog.moveSpace(
                    id,
                    { targetParentId: body.targetParentId ?? null, version: versions[id] },
                    context,
                  )
                : await this.catalog.deleteSpace(
                    id,
                    {
                      version: versions[id],
                      expectedReferenceRevision: Number(current.referenceRevision),
                      referenceStrategy: 'block',
                    },
                    context,
                  );
            succeeded += 1;
            items.push({
              id,
              success: true,
              version:
                action === 'move'
                  ? Number((data as Record<string, unknown>).version ?? 0)
                  : (versions[id] ?? 1) + 1,
              ...(Array.isArray((data as Record<string, unknown>).parentPath)
                ? { parentPath: (data as Record<string, unknown>).parentPath }
                : {}),
            });
          } catch (error) {
            items.push(
              await this.failedBatchItem(
                {
                  id,
                  action,
                  resourceType: 'space',
                  knowledgeSpaceId: id,
                },
                error,
                context,
              ),
            );
          }
        }
        return {
          status: succeeded === ids.length ? 200 : 207,
          data: {
            ...(succeeded === ids.length ? {} : { code: 'KNOWLEDGE_PARTIAL_SUCCESS' }),
            requested: ids.length,
            succeeded,
            failed: ids.length - succeeded,
            items,
          },
        };
      }
      case 'API-SPACE-EXPORT': {
        await this.requireExistingPermission('space', params.spaceId ?? '', 'write', context);
        if (body.format !== undefined && body.format !== 'zip') {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_VALIDATION_FAILED',
            requestId: context.requestId,
            traceId: context.traceId,
            details: { field: 'format', supported: ['zip'] },
          });
        }
        const requestedIds = Array.isArray(body.sourceIds)
          ? [...new Set(body.sourceIds.map(String))]
          : null;
        if (requestedIds && (requestedIds.length < 1 || requestedIds.length > 2000)) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_PAYLOAD_TOO_LARGE',
            requestId: context.requestId,
            traceId: context.traceId,
            details: { field: 'sourceIds', min: 1, max: 2000 },
          });
        }
        const sources = [];
        if (requestedIds) {
          for (const sourceId of requestedIds) {
            sources.push(await this.catalog.getSource(sourceId, context));
          }
        } else {
          let cursor: string | undefined;
          do {
            const page = await this.catalog.listSources(
              params.spaceId ?? '',
              { limit: 200, cursor },
              context,
            );
            sources.push(...page.items);
            cursor = page.pageInfo.nextCursor ?? undefined;
          } while (cursor);
        }
        if (sources.length > 2000) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_PAYLOAD_TOO_LARGE',
            requestId: context.requestId,
            traceId: context.traceId,
            details: { field: 'sourceIds', max: 2000 },
          });
        }
        const sourceVersions: Record<string, number> = {};
        for (const source of sources) {
          if (source.knowledgeSpaceId !== params.spaceId) {
            throw createKnowledgeError({
              code: 'KNOWLEDGE_NOT_FOUND',
              requestId: context.requestId,
              traceId: context.traceId,
              details: { sourceId: source.id },
            });
          }
          await this.requireExistingPermission('source', source.id, 'read', context);
          sourceVersions[source.id] = Number(source.version);
        }
        const headerValue = input.headers?.['idempotency-key'];
        const suppliedKey = Array.isArray(headerValue) ? headerValue[0] : headerValue;
        const idempotencyKey =
          suppliedKey ??
          `space-export:${createHash('sha256')
            .update(
              [
                context.workspaceId,
                params.spaceId ?? '',
                'zip',
                sources
                  .map((source) => `${source.id}:${source.version}`)
                  .sort()
                  .join(','),
              ].join('|'),
            )
            .digest('hex')}`;
        return {
          status: 202,
          data: await this.jobs.createExportJob(
            {
              spaceId: params.spaceId ?? '',
              sourceIds: sources.map((source) => source.id),
              sourceVersions,
              format: 'zip',
              exportScope: 'space',
              idempotencyKey,
            },
            context,
          ),
        };
      }
      case 'API-DIRECTORY-LIST': {
        await this.access.assertPermission('space', params.spaceId ?? '', 'read', context);
        return {
          status: 200,
          data: await this.catalog.listDirectories(
            params.spaceId ?? '',
            pageQuery(input.query),
            context,
          ),
        };
      }
      case 'API-DIRECTORY-CREATE': {
        await this.access.assertPermission('space', params.spaceId ?? '', 'write', context);
        return {
          status: 201,
          data: await this.catalog.createDirectory(
            params.spaceId ?? '',
            {
              parentDirectoryId: (body.parentDirectoryId as string | null | undefined) ?? null,
              name: String(body.name ?? ''),
            },
            context,
          ),
        };
      }
      case 'API-DIRECTORY-GET': {
        await this.access.assertPermission('directory', params.directoryId ?? '', 'read', context);
        return {
          status: 200,
          data: await this.catalog.getDirectory(params.directoryId ?? '', context),
        };
      }
      case 'API-DIRECTORY-UPDATE': {
        await this.access.assertPermission('directory', params.directoryId ?? '', 'write', context);
        return {
          status: 200,
          data: await this.catalog.updateDirectory(params.directoryId ?? '', body, context),
        };
      }
      case 'API-DIRECTORY-DELETE': {
        await this.access.assertPermission(
          'directory',
          params.directoryId ?? '',
          'manage',
          context,
        );
        return {
          status: 202,
          data: await this.catalog.deleteDirectory(params.directoryId ?? '', context),
        };
      }
      case 'API-DIRECTORY-MOVE': {
        await this.requireExistingPermission(
          'directory',
          params.directoryId ?? '',
          'write',
          context,
        );
        if (body.targetParentId && typeof body.targetParentId === 'string') {
          await this.requireExistingPermission('directory', body.targetParentId, 'write', context);
        }
        return {
          status: 200,
          data: await this.catalog.moveDirectoryTree(params.directoryId ?? '', body, context),
        };
      }
      case 'API-SOURCE-LIST': {
        await this.access.assertPermission('space', params.spaceId ?? '', 'read', context);
        return {
          status: 200,
          data: await this.catalog.listSources(
            params.spaceId ?? '',
            pageQuery(input.query),
            context,
          ),
        };
      }
      case 'API-SOURCE-CREATE': {
        await this.access.assertPermission('space', params.spaceId ?? '', 'write', context);
        return {
          status: 201,
          data: await this.catalog.createSource(
            params.spaceId ?? '',
            {
              kind: body.kind as
                | 'file'
                | 'text'
                | 'url'
                | 'template'
                | 'backup'
                | 'api_library'
                | 'feishu'
                | 'yuque'
                | 'dingtalk'
                | 'image',
              directoryId: (body.directoryId as string | null | undefined) ?? null,
              name: String(body.name ?? ''),
              searchEnabled: typeof body.searchEnabled === 'boolean' ? body.searchEnabled : true,
              metadata:
                typeof body.metadata === 'object' && body.metadata !== null
                  ? (body.metadata as Record<string, unknown>)
                  : {},
            },
            context,
          ),
        };
      }
      case 'API-SOURCE-GET': {
        await this.access.assertPermission('source', params.sourceId ?? '', 'read', context);
        return {
          status: 200,
          data: await this.catalog.getSource(params.sourceId ?? '', context),
        };
      }
      case 'API-SOURCE-UPDATE': {
        await this.access.assertPermission('source', params.sourceId ?? '', 'write', context);
        return {
          status: 200,
          data: await this.catalog.updateSource(params.sourceId ?? '', body, context),
        };
      }
      case 'API-SOURCE-DELETE': {
        await this.access.assertPermission('source', params.sourceId ?? '', 'manage', context);
        return {
          status: 202,
          data: await this.catalog.deleteSource(params.sourceId ?? '', context),
        };
      }
      case 'API-SOURCE-MOVE': {
        await this.requireExistingPermission('source', params.sourceId ?? '', 'write', context);
        if (body.targetParentId && typeof body.targetParentId === 'string') {
          await this.requireExistingPermission('directory', body.targetParentId, 'write', context);
        }
        return {
          status: 200,
          data: await this.catalog.moveSource(params.sourceId ?? '', body, context),
        };
      }
      case 'API-SOURCE-BATCH': {
        const ids = this.normalizeBatchIds(body.ids, context);
        const versions = assertBatchVersions(ids, body.versions, context);
        const action = String(body.action ?? '');
        if (action !== 'move' && action !== 'delete') {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_VALIDATION_FAILED',
            requestId: context.requestId,
            traceId: context.traceId,
            details: { field: 'action', supported: ['move', 'delete'] },
          });
        }
        if (action === 'move' && !Object.hasOwn(body, 'targetDirectoryId')) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_VALIDATION_FAILED',
            requestId: context.requestId,
            traceId: context.traceId,
            details: { field: 'targetDirectoryId', reason: 'required_for_move' },
          });
        }
        if (action === 'delete' && body.targetDirectoryId != null) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_VALIDATION_FAILED',
            requestId: context.requestId,
            traceId: context.traceId,
            details: { field: 'targetDirectoryId', reason: 'not_allowed_for_delete' },
          });
        }
        if (action === 'move' && body.targetDirectoryId != null) {
          await this.requireExistingPermission(
            'directory',
            String(body.targetDirectoryId),
            'write',
            context,
          );
        }
        const candidates = new Map<string, { source: SourceView; spaceId: string }>();
        const failures = new Map<string, Record<string, unknown>>();
        const attempts = new Map<string, string>();
        for (const id of ids) {
          try {
            await this.requireExistingPermission('source', id, 'manage', context);
            const source = await this.catalog.getSource(id, context);
            attempts.set(id, source.knowledgeSpaceId);
            if (Number(source.version) !== versions[id]) {
              throw createKnowledgeError({
                code: 'KNOWLEDGE_CONFLICT',
                requestId: context.requestId,
                traceId: context.traceId,
                details: { resourceId: id, field: 'version' },
              });
            }
            candidates.set(id, { source, spaceId: source.knowledgeSpaceId });
          } catch (error) {
            failures.set(
              id,
              await this.failedBatchItem(
                {
                  id,
                  action,
                  resourceType: 'source',
                  knowledgeSpaceId: attempts.get(id) ?? null,
                },
                error,
                context,
              ),
            );
          }
        }
        const sourceSpaces = new Set(
          [...candidates.values()].map((candidate) => candidate.spaceId),
        );
        if (sourceSpaces.size > 1) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_VALIDATION_FAILED',
            requestId: context.requestId,
            traceId: context.traceId,
            details: { field: 'ids', reason: 'single_knowledge_space_required' },
          });
        }
        const items: Array<Record<string, unknown>> = [];
        let succeeded = 0;
        for (const id of ids) {
          const failed = failures.get(id);
          if (failed) {
            items.push(failed);
            continue;
          }
          try {
            const data =
              action === 'move'
                ? await this.catalog.moveSource(
                    id,
                    {
                      targetParentId: body.targetDirectoryId ?? null,
                      version: versions[id],
                    },
                    context,
                  )
                : await this.catalog.deleteSource(id, context, versions[id]);
            succeeded += 1;
            items.push({
              id,
              success: true,
              ...(action === 'move'
                ? {
                    version: Number((data as Record<string, unknown>).version ?? 0),
                    parentPath: (data as Record<string, unknown>).parentPath,
                  }
                : {}),
            });
          } catch (error) {
            items.push(
              await this.failedBatchItem(
                {
                  id,
                  action,
                  resourceType: 'source',
                  knowledgeSpaceId: candidates.get(id)?.spaceId ?? null,
                },
                error,
                context,
              ),
            );
          }
        }
        return {
          status: succeeded === ids.length ? 200 : 207,
          data: {
            ...(succeeded === ids.length ? {} : { code: 'KNOWLEDGE_PARTIAL_SUCCESS' }),
            requested: ids.length,
            succeeded,
            failed: ids.length - succeeded,
            items,
          },
        };
      }
      case 'API-SEGMENT-LIST': {
        await this.access.assertPermission('source', params.sourceId ?? '', 'read', context);
        return {
          status: 200,
          data: await this.catalog.listSegments(
            params.sourceId ?? '',
            pageQuery(input.query),
            context,
          ),
        };
      }
      case 'API-SEGMENT-CREATE': {
        await this.access.assertPermission('source', params.sourceId ?? '', 'write', context);
        return {
          status: 201,
          data: await this.catalog.createSegment(
            params.sourceId ?? '',
            {
              question: String(body.question ?? ''),
              answer: String(body.answer ?? ''),
              searchEnabled: typeof body.searchEnabled === 'boolean' ? body.searchEnabled : true,
              metadata:
                typeof body.metadata === 'object' && body.metadata !== null
                  ? (body.metadata as Record<string, unknown>)
                  : {},
              indexes: Array.isArray(body.indexes) ? (body.indexes as never) : undefined,
            },
            context,
          ),
        };
      }
      case 'API-SEGMENT-GET': {
        const segment = await this.catalog.getSegment(params.segmentId ?? '', context);
        await this.access.assertPermission('source', segment.sourceId, 'read', context);
        return {
          status: 200,
          data: segment,
        };
      }
      case 'API-SEGMENT-UPDATE': {
        const segment = await this.catalog.getSegment(params.segmentId ?? '', context);
        await this.access.assertPermission('source', segment.sourceId, 'write', context);
        return {
          status: 200,
          data: await this.catalog.updateSegment(params.segmentId ?? '', body, context),
        };
      }
      case 'API-SEGMENT-DELETE': {
        const segment = await this.catalog.getSegment(params.segmentId ?? '', context);
        await this.access.assertPermission('source', segment.sourceId, 'manage', context);
        return {
          status: 202,
          data: await this.catalog.deleteSegment(params.segmentId ?? '', context),
        };
      }
      case 'API-TAG-LIST': {
        await this.access.assertPermission('space', params.spaceId ?? '', 'read', context);
        return {
          status: 200,
          data: await this.tags.list(params.spaceId ?? '', context),
        };
      }
      case 'API-TAG-CREATE': {
        await this.access.assertPermission('space', params.spaceId ?? '', 'manage', context);
        return {
          status: 201,
          data: await this.tags.create(params.spaceId ?? '', body, context),
        };
      }
      case 'API-TAG-GET': {
        const tag = await this.tags.get(params.tagId ?? '', context);
        await this.access.assertPermission('space', tag.knowledgeSpaceId, 'read', context);
        return { status: 200, data: tag };
      }
      case 'API-TAG-UPDATE': {
        const tag = await this.tags.get(params.tagId ?? '', context);
        await this.access.assertPermission('space', tag.knowledgeSpaceId, 'manage', context);
        return {
          status: 200,
          data: await this.tags.update(params.tagId ?? '', body, context),
        };
      }
      case 'API-TAG-DELETE': {
        const tag = await this.tags.get(params.tagId ?? '', context);
        await this.access.assertPermission('space', tag.knowledgeSpaceId, 'manage', context);
        await this.tags.delete(params.tagId ?? '', context);
        return { status: 204, data: null };
      }
      case 'API-TAG-VALUES': {
        const tag = await this.tags.get(params.tagId ?? '', context);
        await this.access.assertPermission('space', tag.knowledgeSpaceId, 'manage', context);
        return {
          status: 200,
          data: await this.tags.updateOptions(params.tagId ?? '', body, context),
        };
      }
      case 'API-TAG-APPLY': {
        const items = Array.isArray(body.items) ? body.items : [];
        for (const raw of items) {
          const item = raw as Record<string, unknown>;
          const source = await this.catalog.getSource(String(item.sourceId ?? ''), context);
          await this.access.assertPermission('source', source.id, 'write', context);
        }
        return { status: 200, data: await this.tags.apply(body, context) };
      }
      case 'API-ACL-GET':
        return {
          status: 200,
          data: await this.access.getAcl(
            resourceTypeOf(params.resourceType, context),
            params.resourceId ?? '',
            context,
          ),
        };
      case 'API-ACL-UPDATE':
        return {
          status: 200,
          data: await this.access.updateAcl(
            resourceTypeOf(params.resourceType, context),
            params.resourceId ?? '',
            body,
            context,
          ),
        };
      case 'API-ACL-RESUME':
        return {
          status: 200,
          data: await this.access.resumeAcl(
            resourceTypeOf(params.resourceType, context),
            params.resourceId ?? '',
            body,
            context,
          ),
        };
      case 'API-COLLABORATOR-LIST':
        return {
          status: 200,
          data: await this.access.listCollaborators(params.spaceId ?? '', context),
        };
      case 'API-COLLABORATOR-CREATE':
        return {
          status: 201,
          data: await this.access.createCollaborator(params.spaceId ?? '', body, context),
        };
      case 'API-COLLABORATOR-UPDATE':
        return {
          status: 200,
          data: await this.access.updateCollaborator(
            params.spaceId ?? '',
            params.memberId ?? '',
            body,
            context,
          ),
        };
      case 'API-COLLABORATOR-DELETE':
        await this.access.deleteCollaborator(params.spaceId ?? '', params.memberId ?? '', context);
        return { status: 204, data: null };
      case 'API-OWNERSHIP-TRANSFER':
        await this.access.transferOwnership('space', params.spaceId ?? '', body, context);
        return {
          status: 200,
          data: await this.catalog.getSpace(params.spaceId ?? '', context),
        };
      case 'API-RESOURCE-OWNERSHIP-TRANSFER':
        return {
          status: 200,
          data: await this.access.transferOwnership(
            resourceTypeOf(params.resourceType, context),
            params.resourceId ?? '',
            body,
            context,
          ),
        };
      case 'API-PERMISSION-ENABLE':
        return {
          status: 200,
          data: await this.access.transitionSourcePermission(
            params.sourceId ?? '',
            'enable',
            body,
            context,
          ),
        };
      case 'API-PERMISSION-DISABLE':
        return {
          status: 200,
          data: await this.access.transitionSourcePermission(
            params.sourceId ?? '',
            'disable',
            body,
            context,
          ),
        };
      case 'API-PERMISSION-DETACH':
        return {
          status: 200,
          data: await this.access.transitionSourcePermission(
            params.sourceId ?? '',
            'detach',
            body,
            context,
          ),
        };
      case 'API-PERMISSION-RESUME':
        return {
          status: 200,
          data: await this.access.transitionSourcePermission(
            params.sourceId ?? '',
            'resume',
            body,
            context,
          ),
        };
      case 'API-JOB-LIST':
        return { status: 200, data: await this.jobs.list(pageQuery(input.query), context) };
      case 'API-JOB-GET':
        return {
          status: 200,
          data: await this.jobs.get(params.jobId ?? '', context),
        };
      case 'API-UPLOAD-INIT':
        return {
          status: 201,
          data: await this.files!.init(
            {
              knowledgeSpaceId: String(body.knowledgeSpaceId ?? ''),
              name: String(body.name ?? ''),
              mimeType: String(body.mimeType ?? ''),
              sizeBytes: Number(body.sizeBytes),
            },
            context,
          ),
        };
      case 'API-UPLOAD-PRESIGN':
        return {
          status: 200,
          data: await this.files!.presign(
            params.uploadId ?? '',
            {
              partNumbers: Array.isArray(body.partNumbers)
                ? body.partNumbers.map((value) => Number(value))
                : [],
            },
            context,
          ),
        };
      case 'API-UPLOAD-PART': {
        if (!(input.body instanceof Uint8Array)) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_VALIDATION_FAILED',
            requestId: context.requestId,
            traceId: context.traceId,
            details: { field: 'body', reason: 'binary_required' },
          });
        }
        return {
          status: 200,
          data: await this.files!.uploadPart(
            params.uploadId ?? '',
            Number(params.partNumber),
            input.body,
            context,
          ),
        };
      }
      case 'API-UPLOAD-COMPLETE': {
        const completed = await this.files!.complete(
          {
            uploadId: params.uploadId ?? '',
            parts: Array.isArray(body.parts)
              ? body.parts.map((raw) => {
                  const part = raw as Record<string, unknown>;
                  return {
                    partNumber: Number(part.partNumber),
                    etag: String(part.etag ?? ''),
                  };
                })
              : [],
          },
          context,
        );
        return {
          status: 200,
          data: {
            blobId: completed.blobId,
            workspaceId: completed.workspaceId,
            bucket: completed.bucket,
            objectKey: completed.objectKey,
            state: completed.state,
            sizeBytes: completed.sizeBytes,
            etag: completed.etag,
          },
        };
      }
      case 'API-UPLOAD-ABORT':
        return {
          status: 200,
          data: await this.files!.abort(params.uploadId ?? '', Number(body.version), context),
        };
      case 'API-UPLOAD-GET':
        return {
          status: 200,
          data: await this.files!.get(params.uploadId ?? '', context),
        };
      case 'API-FILE-PREVIEW':
        return {
          status: 200,
          data: await this.files!.preview(
            params.blobId ?? '',
            {
              ttlSeconds:
                typeof body.ttlSeconds === 'number'
                  ? body.ttlSeconds
                  : typeof body.expiresInSeconds === 'number'
                    ? body.expiresInSeconds
                    : undefined,
            },
            context,
          ),
        };
      case 'API-FILE-DOWNLOAD':
        return {
          status: 200,
          data: await this.files!.download(
            params.blobId ?? '',
            {
              ttlSeconds:
                typeof body.ttlSeconds === 'number'
                  ? body.ttlSeconds
                  : typeof body.expiresInSeconds === 'number'
                    ? body.expiresInSeconds
                    : undefined,
            },
            context,
          ),
        };
      case 'API-FILE-CONTENT': {
        const ticket = firstQuery(input.query, 'ticket') ?? null;
        const rangeValue = input.headers?.range ?? input.headers?.Range;
        const range = Array.isArray(rangeValue) ? rangeValue[0] : rangeValue;
        const binary = await this.files!.content(
          params.blobId ?? '',
          range ?? null,
          ticket,
          context,
        );
        return {
          status: binary.contentRange ? 206 : 200,
          data: null,
          binary,
          headers: {
            'Content-Type': binary.contentType ?? 'application/octet-stream',
            'Content-Length': String(binary.size),
            'Accept-Ranges': 'bytes',
            ETag: `"${binary.etag}"`,
            'Content-Disposition': `${binary.disposition}; filename="${binary.filename.replaceAll(
              '"',
              '',
            )}"`,
            ...(binary.contentRange ? { 'Content-Range': binary.contentRange } : {}),
          },
        };
      }
      case 'API-SOURCE-PREVIEW':
        return {
          status: 200,
          data: await this.sources!.preview(params.sourceId ?? '', context),
        };
      case 'API-SOURCE-DOWNLOAD':
        return {
          status: 200,
          data: await this.sources!.download(params.sourceId ?? '', context),
        };
      case 'API-SOURCE-ARCHIVE':
        return {
          status: 202,
          data: await this.sources!.archive(
            params.spaceId ?? '',
            Array.isArray(body.sourceIds) ? body.sourceIds.map((sourceId) => String(sourceId)) : [],
            context,
          ),
        };
      default:
        throw createKnowledgeError({
          code: 'KNOWLEDGE_INTERNAL_ERROR',
          requestId: context.requestId,
          traceId: context.traceId,
          details: { reason: 'operation_not_in_application', operationId: input.operationId },
        });
    }
  }
}
