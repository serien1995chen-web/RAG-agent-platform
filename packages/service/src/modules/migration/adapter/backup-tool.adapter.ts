import { ApiErrorException, createApiError } from '@kb/contracts';
import { createHash } from 'node:crypto';
import type { BackupToolPort } from '../../../ports/capabilities';
import type { PortCallOptions, RequestContext } from '../../../ports/types';

function notConfigured(requestId: string): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code: 501062,
      requestId,
      params: { dependency: 'backup' },
    }),
  );
}

function commandOf(
  command: unknown,
  requestId: string,
): {
  toolRef: string;
  artifactRef: string;
  changeId: string;
} {
  if (typeof command !== 'object' || command === null || Array.isArray(command)) {
    throw notConfigured(requestId);
  }
  const value = command as Record<string, unknown>;
  const toolRef = value.toolRef;
  const artifactRef = value.artifactRef;
  const changeId = value.changeId;
  if (
    typeof toolRef !== 'string' ||
    toolRef.length === 0 ||
    typeof artifactRef !== 'string' ||
    artifactRef.length === 0 ||
    typeof changeId !== 'string' ||
    changeId.length === 0
  ) {
    throw notConfigured(requestId);
  }
  return { toolRef, artifactRef, changeId };
}

function checksumOf(toolRef: string, artifactRef: string, changeId: string): string {
  return `sha256:${createHash('sha256')
    .update(`${toolRef}:${artifactRef}:${changeId}`)
    .digest('hex')}`;
}

export class BackupToolAdapter implements BackupToolPort {
  async validate(
    input: { command: unknown; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ valid: boolean }> {
    commandOf(input.command, context.requestId);
    return { valid: true };
  }

  async run(
    input: { command: unknown; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ evidence: unknown }> {
    const command = commandOf(input.command, context.requestId);
    return {
      evidence: {
        changeId: command.changeId,
        toolRef: command.toolRef,
        artifactRef: command.artifactRef,
        checksum: checksumOf(command.toolRef, command.artifactRef, command.changeId),
        mode: 'mock',
        completedAt: new Date().toISOString(),
      },
    };
  }

  async verify(
    input: { evidence: unknown; options: PortCallOptions },
    _context: RequestContext,
  ): Promise<{ verified: boolean }> {
    if (typeof input.evidence !== 'object' || input.evidence === null) {
      return { verified: false };
    }
    const evidence = input.evidence as Record<string, unknown>;
    if (
      evidence.mode !== 'mock' ||
      typeof evidence.checksum !== 'string' ||
      evidence.checksum.length === 0 ||
      typeof evidence.changeId !== 'string' ||
      typeof evidence.toolRef !== 'string' ||
      typeof evidence.artifactRef !== 'string'
    ) {
      return { verified: false };
    }
    return { verified: false };
  }
}

export function createBackupToolAdapter(): BackupToolAdapter {
  return new BackupToolAdapter();
}
