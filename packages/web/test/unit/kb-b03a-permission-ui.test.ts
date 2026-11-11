import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as KnowledgeClient from '../../src/client/knowledge-client';

vi.mock('../../src/client/knowledge-client', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof KnowledgeClient;
  return {
    ...actual,
    knowledgeRequest: vi.fn(async () => ({})),
  };
});

import { knowledgeRequest } from '../../src/client/knowledge-client';
import {
  transferSpaceOwnership,
  transitionSourcePermission,
  updateAcl,
  updateCollaborator,
} from '../../src/product/api';
import type { Acl, Collaborator, Source } from '../../src/product/types';

const requestMock = vi.mocked(knowledgeRequest);

beforeEach(() => {
  requestMock.mockClear();
});

describe('B03A permission UI request contract', () => {
  it('L1-B03-COL-004-UI01 maps resume-inherit to the Source permission endpoint with CAS fields', async () => {
    const source = {
      id: '65f1e5b2a1c9d4b7e8f01234',
      version: 8,
      permissionRevision: 3,
    } as Source;
    await transitionSourcePermission(source, 'resume-inherit');
    expect(requestMock).toHaveBeenCalledWith(
      '/v1/knowledge/sources/65f1e5b2a1c9d4b7e8f01234/permissions/resume-inherit',
      expect.objectContaining({
        method: 'POST',
        body: {
          version: 8,
          expectedPermissionRevision: 3,
        },
      }),
    );
  });

  it('L1-B03-COL-004-UI01 sends the ACLUpdate contract field version, not revision-only UI fields', async () => {
    const call = updateAcl as unknown as (
      resourceType: 'space' | 'directory' | 'source',
      resourceId: string,
      input: Record<string, unknown>,
      resourceVersion?: number,
    ) => Promise<Acl>;
    await call(
      'source',
      '65f1e5b2a1c9d4b7e8f01234',
      {
        inheritMode: 'override',
        permissionState: 'independent',
        permissionRevision: 3,
        snapshotVersion: 2,
        entries: [
          {
            principalType: 'member',
            principalId: 'mem_reader',
            permission: 'read',
          },
        ],
      },
      9,
    );
    expect(requestMock).toHaveBeenCalledWith(
      '/v1/knowledge/resources/source/65f1e5b2a1c9d4b7e8f01234/acl',
      expect.objectContaining({
        method: 'PUT',
        body: {
          inheritMode: 'override',
          version: 9,
          entries: [
            {
              principalType: 'member',
              principalId: 'mem_reader',
              permission: 'read',
            },
          ],
        },
      }),
    );
  });

  it('L1-B03-AUTH-002-UI01 sends the collaborator row version for role updates', async () => {
    const collaborator = {
      memberId: 'mem_reader',
      role: 'read',
      status: 'active',
      grantedAt: '2026-11-11T00:00:00.000Z',
      version: 7,
    } as Collaborator;
    await updateCollaborator('65f1e5b2a1c9d4b7e8f01234', collaborator, 'write');
    expect(requestMock).toHaveBeenCalledWith(
      '/v1/knowledge/spaces/65f1e5b2a1c9d4b7e8f01234/collaborators/mem_reader',
      expect.objectContaining({
        method: 'PATCH',
        body: { role: 'write', version: 7 },
      }),
    );
  });

  it('L1-B03-AUTH-004-UI01 sends ownership target and resource version', async () => {
    await transferSpaceOwnership('65f1e5b2a1c9d4b7e8f01234', 'mem_target', 12);
    expect(requestMock).toHaveBeenCalledWith(
      '/v1/knowledge/spaces/65f1e5b2a1c9d4b7e8f01234/ownership-transfer',
      expect.objectContaining({
        method: 'POST',
        body: { targetMemberId: 'mem_target', version: 12 },
      }),
    );
  });
});
