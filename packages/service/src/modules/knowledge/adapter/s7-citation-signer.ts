import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { S7CitationSignerPort } from '../application/s7-search.ports';
import { ConfigValidationException } from '../../../shared/config/config-error';

const CITATION_ID =
  /^cit_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

function signingPayload(workspaceId: string, citationUuid: string): string {
  return `${workspaceId}|${citationUuid}`;
}

export class S7CitationSigner implements S7CitationSignerPort {
  constructor(private readonly secret: string) {
    if (secret.length < 32) {
      throw new ConfigValidationException([
        'citation signing secret must contain at least 32 characters',
      ]);
    }
  }

  private signature(workspaceId: string, citationUuid: string): string {
    return createHmac('sha256', this.secret)
      .update(signingPayload(workspaceId, citationUuid), 'utf8')
      .digest('base64url');
  }

  issue(workspaceId: string, citationUuid: string = randomUUID()): string {
    return `cit_${citationUuid}.${this.signature(workspaceId, citationUuid)}`;
  }

  verify(citationId: string, workspaceId: string): boolean {
    const match = CITATION_ID.exec(citationId);
    if (!match) return false;
    const expected = Buffer.from(this.signature(workspaceId, match[1]!), 'base64url');
    const actual = Buffer.from(match[2]!, 'base64url');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}
