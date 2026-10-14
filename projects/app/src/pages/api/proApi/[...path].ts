import { ApiErrorException, createApiError } from '@kb/contracts';
import { CollaboratorService, OwnerTransferService } from '@kb/service';
import type { CollaboratorPermission } from '@kb/service';
import type { NextApiRequest, NextApiResponse } from 'next';
import { createOwnerTransferAdapter } from '../../../../../../packages/service/src/modules/permission/adapter/owner-transfer.adapter';
import { getRuntime } from '../../../runtime';
import { authenticateRequest } from '../../../runtime/auth';
import { matchRoute, parseDto, successResponse, withApiHandler } from '../../../shared/api';
import type { ApiHandlerContext } from '../../../shared/api';

interface DatasetDetailQuery {
  datasetId: string;
}

interface ApiACL004RequestData {
  datasetId: string;
  collaborators: unknown[];
  version: number;
}

interface ApiACL005RequestData {
  datasetId: string;
  targetTmbId: string;
  transferId: string;
}

interface ExtensionEnvelope {
  requestId: string;
  extensionId: string;
  payload: { schemaRef: string; data: unknown };
  idempotencyKey?: string;
}

const ALLOWED_ROUTE_IDS = new Set(['API-EXT-001', 'API-ACL-003', 'API-ACL-004', 'API-ACL-005']);

const EXTENSION_IDS = new Set(['identity', 'agent', 'application', 'publish']);
const COLLABORATOR_TYPES = new Set(['member', 'group', 'org', 'owner']);

function isZodError(error: unknown): error is { issues: unknown } {
  return error instanceof Error && error.name === 'ZodError';
}

/** DTO 入参错误按路由声明的 400 业务码映射（Plan §6.3：ACL-003/EXT-001→501020、ACL-004→501047、ACL-005→501008）。 */
function parseOrThrow<T>(dtoName: string, value: unknown, code: number, requestId: string): T {
  try {
    return parseDto<T>(dtoName, value);
  } catch (error) {
    if (isZodError(error)) {
      throw new ApiErrorException(createApiError({ code, requestId, zodError: error.issues }));
    }
    throw error;
  }
}

function toCollaborators(
  raw: unknown[],
  datasetId: string,
  version: number,
  requestId: string,
): CollaboratorPermission[] {
  return raw.map((item) => {
    const record = (typeof item === 'object' && item !== null ? item : {}) as Record<
      string,
      unknown
    >;
    const collaboratorType = record.collaboratorType;
    const collaboratorId = record.collaboratorId;
    const permissionMask = record.permissionMask;
    const valid =
      typeof collaboratorType === 'string' &&
      COLLABORATOR_TYPES.has(collaboratorType) &&
      typeof collaboratorId === 'string' &&
      collaboratorId.length > 0 &&
      typeof permissionMask === 'number' &&
      Number.isInteger(permissionMask) &&
      permissionMask >= 0 &&
      permissionMask <= 15;
    if (!valid) {
      throw new ApiErrorException(
        createApiError({
          code: 501047,
          requestId,
          params: { datasetId, expectedVersion: version },
        }),
      );
    }
    return {
      collaboratorType: collaboratorType as CollaboratorPermission['collaboratorType'],
      collaboratorId: collaboratorId as string,
      permissionMask: permissionMask as number,
    };
  });
}

/**
 * 扩展 API 统一入口（实际路径 /api/proApi/**，SKEL-ADR-006 / API-EXT-001）。
 * 按 ExtensionRegistry 分发 API-EXT-001 / ACL-003 / ACL-004 / ACL-005；
 * 未匹配或扩展未启用返回稳定错误 501020，核心 Dataset 路由不受影响；不修改 runtime。
 */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const registryUrl = (request.url ?? '').replace(/^\/api/, '');
    const route = matchRoute(request.method, registryUrl);
    if (route === null || !ALLOWED_ROUTE_IDS.has(route.routeId)) {
      throw new ApiErrorException(
        createApiError({
          code: 501020,
          requestId,
          params: { extension: route?.routeId ?? 'proApi' },
        }),
      );
    }

    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);

    const collaboratorService = new CollaboratorService({
      repository: runtime.datasetPermission,
      audit: runtime.ports.audit,
      notifications: runtime.ports.datasetNotification,
    });
    const ownerTransferService = new OwnerTransferService({
      store: createOwnerTransferAdapter({ connection: runtime.clients.mongo }),
      idempotency: runtime.clients.idempotencyStore,
      audit: runtime.ports.audit,
      notifications: runtime.ports.datasetNotification,
    });

    const listCollaborators = async (input: unknown) => {
      const query = parseOrThrow<DatasetDetailQuery>(
        'DatasetDetailQuery',
        input,
        501020,
        requestId,
      );
      return collaboratorService.list(
        { datasetId: query.datasetId, options: { timeoutMs: 5_000 } },
        context,
      );
    };
    const updateCollaborators = async (body: unknown) => {
      const parsed = parseOrThrow<ApiACL004RequestData>(
        'ApiACL004RequestData',
        body,
        501047,
        requestId,
      );
      const collaborators = toCollaborators(
        parsed.collaborators,
        parsed.datasetId,
        parsed.version,
        requestId,
      );
      const snapshot = await collaboratorService.update(
        {
          datasetId: parsed.datasetId,
          expectedVersion: parsed.version,
          collaborators,
          options: { timeoutMs: 5_000 },
        },
        context,
      );
      return { snapshot };
    };
    const changeOwner = async (body: unknown) => {
      const parsed = parseOrThrow<ApiACL005RequestData>(
        'ApiACL005RequestData',
        body,
        501008,
        requestId,
      );
      return ownerTransferService.transfer(
        {
          datasetId: parsed.datasetId,
          targetTmbId: parsed.targetTmbId,
          transferId: parsed.transferId,
          options: { timeoutMs: 5_000 },
        },
        context,
      );
    };

    if (route.routeId === 'API-ACL-003') {
      const { list } = await listCollaborators(request.query);
      response.status(200).json(successResponse({ list }, requestId));
      return;
    }
    if (route.routeId === 'API-ACL-004') {
      const { snapshot } = await updateCollaborators(request.body);
      response.status(200).json(successResponse({ snapshot }, requestId));
      return;
    }
    if (route.routeId === 'API-ACL-005') {
      const { before, after } = await changeOwner(request.body);
      response.status(200).json(successResponse({ before, after }, requestId));
      return;
    }

    // API-EXT-001：按 ExtensionRegistry 与 schemaRef 分发。
    const envelope = parseOrThrow<ExtensionEnvelope>(
      'ExtensionEnvelope',
      request.body,
      501020,
      requestId,
    );
    if (!EXTENSION_IDS.has(envelope.extensionId)) {
      throw new ApiErrorException(
        createApiError({
          code: 501020,
          requestId,
          params: { extension: envelope.extensionId },
        }),
      );
    }
    runtime.extensions.require(
      envelope.extensionId as 'identity' | 'agent' | 'application' | 'publish',
      requestId,
    );

    const schemaRef = envelope.payload.schemaRef;
    let data: unknown;
    if (schemaRef === 'collaborator/list') {
      data = await listCollaborators(envelope.payload.data);
    } else if (schemaRef === 'collaborator/update') {
      data = await updateCollaborators(envelope.payload.data);
    } else if (schemaRef === 'changeOwner') {
      data = await changeOwner(envelope.payload.data);
    } else if (schemaRef === 'datasetSync') {
      const payload = (envelope.payload.data ?? {}) as { datasetId?: unknown };
      if (typeof payload.datasetId !== 'string') {
        throw new ApiErrorException(
          createApiError({
            code: 501047,
            requestId,
            params: { datasetId: '', expectedVersion: -1 },
          }),
        );
      }
      data = await runtime.ports.datasetSync.sync(
        {
          datasetId: payload.datasetId,
          idempotencyKey: envelope.idempotencyKey ?? envelope.requestId,
          options: { timeoutMs: 30_000 },
        },
        context,
      );
    } else {
      throw new ApiErrorException(
        createApiError({
          code: 501022,
          requestId,
          params: { extension: envelope.extensionId, event: schemaRef },
        }),
      );
    }

    const envelopeResponse: Record<string, unknown> = {
      requestId,
      extensionId: envelope.extensionId,
      payload: { schemaRef, data },
    };
    if (envelope.idempotencyKey !== undefined) {
      envelopeResponse.idempotencyKey = envelope.idempotencyKey;
    }
    response.status(200).json(envelopeResponse);
  },
);
