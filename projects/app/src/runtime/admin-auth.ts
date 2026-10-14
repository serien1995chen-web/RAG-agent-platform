import { ApiErrorException, createApiError } from '@kb/contracts';
import type { AuthSubject, AuthSubjectProvider } from '@kb/service';
import type { NextApiRequest } from 'next';
import type { AuthenticatedRequest } from './auth';

export type AdminAuthResolver = (
  runtime: { adminAuthProvider?: AuthSubjectProvider },
  request: NextApiRequest,
  requestId: string,
) => Promise<AuthenticatedRequest>;

function forbidden(requestId: string): ApiErrorException {
  return new ApiErrorException(
    createApiError({ code: 501027, requestId, params: { requiredRole: 'root' } }),
  );
}

function isAdminSubject(subject: AuthSubject | null): subject is AuthSubject {
  return subject !== null && (subject.isRoot === true || subject.authType === 'root');
}

export function createAdminAuthResolver(provider?: AuthSubjectProvider): AdminAuthResolver {
  return async (runtime, request, requestId) => {
    const resolvedProvider = provider ?? runtime.adminAuthProvider;
    if (!resolvedProvider) throw forbidden(requestId);
    const subject = await resolvedProvider.resolve(request, requestId);
    if (!isAdminSubject(subject)) throw forbidden(requestId);
    return {
      subject,
      context: {
        requestId,
        tenant: {
          teamId: subject.teamId,
          tmbId: subject.tmbId,
          authType: subject.authType,
          isRoot: subject.isRoot,
          ...(subject.sourceName !== undefined ? { sourceName: subject.sourceName } : {}),
        },
        permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
      },
    };
  };
}

/** Resolve the independent Root/Admin provider; identity-extension enablement is not an input. */
export function resolveAdminRequest(
  runtime: { adminAuthProvider?: AuthSubjectProvider },
  request: NextApiRequest,
  requestId: string,
): Promise<AuthenticatedRequest> {
  return createAdminAuthResolver()(runtime, request, requestId);
}
