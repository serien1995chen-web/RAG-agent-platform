import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createKnowledgeError } from '@kb/contracts';

export type FileTicketDisposition = 'inline' | 'attachment';

export interface FileTicketClaims {
  workspaceId: string;
  memberId: string;
  isWorkspaceOwner: boolean;
  scopes: string[];
  blobId: string;
  sourceId: string | null;
  knowledgeSpaceId: string | null;
  disposition: FileTicketDisposition;
  expiresAt: string;
  nonce: string;
}

export interface FileTicketResult {
  url: string;
  ticket: string;
  expiresAt: string;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function ticketError(
  code: 'KNOWLEDGE_VALIDATION_FAILED' | 'KNOWLEDGE_FORBIDDEN',
  requestId: string,
  traceId: string,
  details: Record<string, unknown> = {},
) {
  return createKnowledgeError({ code, requestId, traceId, details });
}

export class FileTicketService {
  private readonly secret: Buffer;
  private readonly publicBaseUrl: string;

  constructor(
    secretRefValue: string,
    publicBaseUrl: string,
    private readonly now: () => number = Date.now,
  ) {
    if (secretRefValue.length < 32) {
      throw ticketError('KNOWLEDGE_VALIDATION_FAILED', 'config', 'config', {
        field: 'KB_FILE_TICKET_SECRET_REF',
        reason: 'secret_too_short',
      });
    }
    const parsed = new URL(publicBaseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw ticketError('KNOWLEDGE_VALIDATION_FAILED', 'config', 'config', {
        field: 'KB_FILE_PUBLIC_BASE_URL',
        reason: 'http_url_required',
      });
    }
    this.secret = Buffer.from(secretRefValue, 'utf8');
    this.publicBaseUrl = publicBaseUrl.replace(/\/+$/, '');
  }

  issue(
    input: Omit<FileTicketClaims, 'expiresAt' | 'nonce'> & { ttlSeconds: number },
    requestId: string,
    traceId: string,
  ): FileTicketResult {
    if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 1 || input.ttlSeconds > 3600) {
      throw ticketError('KNOWLEDGE_VALIDATION_FAILED', requestId, traceId, {
        field: 'ttlSeconds',
        min: 1,
        max: 3600,
      });
    }
    const claims: FileTicketClaims = {
      workspaceId: input.workspaceId,
      memberId: input.memberId,
      isWorkspaceOwner: input.isWorkspaceOwner,
      scopes: [...input.scopes],
      blobId: input.blobId,
      sourceId: input.sourceId,
      knowledgeSpaceId: input.knowledgeSpaceId,
      disposition: input.disposition,
      expiresAt: new Date(this.now() + input.ttlSeconds * 1000).toISOString(),
      nonce: randomBytes(12).toString('base64url'),
    };
    const payload = base64url(JSON.stringify(claims));
    const signature = createHmac('sha256', this.secret).update(payload).digest('base64url');
    const ticket = `${payload}.${signature}`;
    return {
      url: `${this.publicBaseUrl}/v1/knowledge/files/${encodeURIComponent(
        claims.blobId,
      )}/content?ticket=${encodeURIComponent(ticket)}`,
      ticket,
      expiresAt: claims.expiresAt,
    };
  }

  verify(ticket: string, requestId: string, traceId: string): FileTicketClaims {
    const [payload, signature, extra] = ticket.split('.');
    if (!payload || !signature || extra !== undefined) {
      throw ticketError('KNOWLEDGE_FORBIDDEN', requestId, traceId, {
        reason: 'ticket_malformed',
      });
    }
    const expected = createHmac('sha256', this.secret).update(payload).digest('base64url');
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (
      actualBuffer.byteLength !== expectedBuffer.byteLength ||
      !timingSafeEqual(actualBuffer, expectedBuffer)
    ) {
      throw ticketError('KNOWLEDGE_FORBIDDEN', requestId, traceId, {
        reason: 'ticket_signature_invalid',
      });
    }
    let claims: FileTicketClaims;
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as FileTicketClaims;
    } catch {
      throw ticketError('KNOWLEDGE_FORBIDDEN', requestId, traceId, {
        reason: 'ticket_payload_invalid',
      });
    }
    if (
      typeof claims.workspaceId !== 'string' ||
      typeof claims.memberId !== 'string' ||
      typeof claims.isWorkspaceOwner !== 'boolean' ||
      !Array.isArray(claims.scopes) ||
      claims.scopes.some((scope) => typeof scope !== 'string') ||
      typeof claims.blobId !== 'string' ||
      (claims.sourceId !== null && typeof claims.sourceId !== 'string') ||
      (claims.knowledgeSpaceId !== null && typeof claims.knowledgeSpaceId !== 'string') ||
      (claims.disposition !== 'inline' && claims.disposition !== 'attachment') ||
      typeof claims.expiresAt !== 'string' ||
      typeof claims.nonce !== 'string'
    ) {
      throw ticketError('KNOWLEDGE_FORBIDDEN', requestId, traceId, {
        reason: 'ticket_payload_invalid',
      });
    }
    if (Date.parse(claims.expiresAt) <= this.now()) {
      throw ticketError('KNOWLEDGE_FORBIDDEN', requestId, traceId, {
        reason: 'ticket_expired',
      });
    }
    return claims;
  }
}
