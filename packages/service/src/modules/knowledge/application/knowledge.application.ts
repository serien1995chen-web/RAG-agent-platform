import { createKnowledgeError } from '@kb/contracts';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type { AclResourceType } from '../domain';
import type { AccessPort, CatalogPort, JobPort, TagPort } from './ports';

export interface KnowledgeOperationInput {
  operationId: string;
  params: Readonly<Record<string, string>>;
  query: Readonly<Record<string, string | string[] | undefined>>;
  body: unknown;
  context: TenantContext;
}

export interface KnowledgeOperationResult {
  status: number;
  data: unknown;
  headers?: Readonly<Record<string, string>>;
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
  ) {}

  async dispatch(input: KnowledgeOperationInput): Promise<KnowledgeOperationResult> {
    const { context, params } = input;
    const body = objectBody(input.body, context);
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
