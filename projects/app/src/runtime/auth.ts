import { ApiErrorException, createApiError } from '@kb/contracts';
import type { AuthSubject, AuthSubjectProvider, RequestContext } from '@kb/service';
import type { NextApiRequest } from 'next';
import type { AppRuntime } from './health';

export interface AuthenticatedRequest {
  subject: AuthSubject;
  context: RequestContext;
}

/**
 * 认证主体解析：teamId/tmbId 只能来自 AuthSubjectProvider，绝不接受请求体声明。
 * identity 扩展未启用时返回稳定错误 501020。
 */
export async function authenticateRequest(
  runtime: AppRuntime,
  request: NextApiRequest,
  requestId: string,
): Promise<AuthenticatedRequest> {
  const provider = runtime.extensions.get<AuthSubjectProvider>('identity');
  const subject = provider ? await provider.resolve(request, requestId) : null;
  if (!subject) {
    throw new ApiErrorException(
      createApiError({ code: 501020, requestId, params: { extension: 'identity' } }),
    );
  }
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
}
