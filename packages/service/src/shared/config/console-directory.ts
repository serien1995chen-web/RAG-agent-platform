import { readFileSync } from 'node:fs';
import { createKnowledgeError } from '@kb/contracts';
import { z } from 'zod';
import type { ConsoleSessionPayload } from '../../modules/knowledge/adapter/console-session';
import type { KnowledgeRuntimeConfig } from './knowledge-runtime-config';

const NamedDirectoryEntrySchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    name: z.string().trim().min(1).max(120),
    parentId: z.string().trim().min(1).max(128).nullable().optional(),
  })
  .strict();

const DirectoryMemberSchema = z
  .object({
    memberId: z.string().trim().min(1).max(128),
    name: z.string().trim().min(1).max(120),
    avatarUrl: z.string().trim().max(2048).optional(),
    departmentIds: z.array(z.string().trim().min(1).max(128)).max(64).optional(),
    groupIds: z.array(z.string().trim().min(1).max(128)).max(64).optional(),
  })
  .strict();

const ConsoleDirectorySchema = z
  .object({
    members: z.array(DirectoryMemberSchema).max(5000),
    departments: z.array(NamedDirectoryEntrySchema).max(1000).default([]),
    groups: z.array(NamedDirectoryEntrySchema).max(1000).default([]),
  })
  .strict();

export type ConsoleDirectory = z.infer<typeof ConsoleDirectorySchema>;

function configuredDirectory(config: KnowledgeRuntimeConfig, session: ConsoleSessionPayload) {
  if (config.consoleDirectoryFile) {
    const parsed = ConsoleDirectorySchema.safeParse(
      JSON.parse(readFileSync(config.consoleDirectoryFile, 'utf8')) as unknown,
    );
    if (!parsed.success) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_INTERNAL_ERROR',
        requestId: 'console-directory',
        traceId: 'console-directory',
        details: {
          reason: 'KB_CONSOLE_DIRECTORY_FILE does not match the directory schema',
        },
      });
    }
    const memberIds = new Set(parsed.data.members.map((member) => member.memberId));
    const members = memberIds.has(session.memberId)
      ? parsed.data.members
      : [
          {
            memberId: session.memberId,
            name: session.memberId,
            departmentIds: [],
            groupIds: [],
          },
          ...parsed.data.members,
        ];
    return { ...parsed.data, members };
  }

  const fixture =
    config.auth.mode === 'mock'
      ? [...new Set([session.memberId, ...(config.auth.fixture.workspaceMemberIds ?? [])])]
      : [session.memberId];
  return {
    members: fixture.map((memberId) => ({
      memberId,
      name: memberId,
      departmentIds: [],
      groupIds: [],
    })),
    departments: [],
    groups: [],
  };
}

export function loadConsoleDirectory(
  config: KnowledgeRuntimeConfig,
  session: ConsoleSessionPayload,
): ConsoleDirectory {
  const directory = configuredDirectory(config, session);
  return {
    members: [...new Map(directory.members.map((member) => [member.memberId, member])).values()],
    departments: [
      ...new Map(directory.departments.map((department) => [department.id, department])).values(),
    ],
    groups: [...new Map(directory.groups.map((group) => [group.id, group])).values()],
  };
}
