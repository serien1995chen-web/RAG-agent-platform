'use client';

import { ChevronRightIcon, DeleteIcon, RepeatIcon, SearchIcon } from '@chakra-ui/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import {
  addCollaborator,
  getAcl,
  getSource,
  getSpace,
  listCollaborators,
  listDirectories,
  productDirectory,
  productApi,
  productSession,
  removeCollaborator,
  resumeAcl,
  transitionSourcePermission,
  updateAcl,
  updateCollaborator,
  updateSpace,
} from './api';
import type { Acl, Collaborator, KnowledgeSpace, Source } from './types';
import {
  ProductButton,
  ProductError,
  ProductField,
  ProductIconButton,
  ProductInput,
  ProductModal,
  ProductSelect,
  StatusTag,
} from './ui';

export interface CollaboratorTarget {
  kind: 'space' | 'directory' | 'source';
  id: string;
  name: string;
  version: number;
  source?: Source;
}

type EditableRole = Exclude<Acl['entries'][number]['permission'], 'owner'>;
type Category = 'member' | 'department' | 'group';

interface DraftEntry {
  key: string;
  principalType: 'member' | 'group' | 'org';
  principalId: string;
  name: string;
  avatarUrl?: string;
  role: Acl['entries'][number]['permission'];
  protected: boolean;
  collaborator?: Collaborator;
}

const ROLE_LABELS: Record<EditableRole, string> = {
  read: '只读',
  write: '可写',
  manage: '可管理',
};

function keyOf(principalType: Acl['entries'][number]['principalType'], principalId: string) {
  return `${principalType}:${principalId}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '协作者保存失败，请重试。';
}

export function CollaboratorManagerDialog(props: {
  target: CollaboratorTarget | null;
  space?: KnowledgeSpace;
  onClose: () => void;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<DraftEntry[]>([]);
  const [category, setCategory] = useState<Category | null>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [initializedTarget, setInitializedTarget] = useState('');
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferMemberId, setTransferMemberId] = useState('');
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferError, setTransferError] = useState<unknown>(null);

  const enabled = Boolean(props.target);
  const session = useQuery({
    queryKey: ['kb-product', 'session'],
    queryFn: productSession,
    enabled,
  });
  const directory = useQuery({
    queryKey: ['kb-product', 'directory'],
    queryFn: productDirectory,
    enabled,
  });
  const collaborators = useQuery({
    queryKey: ['kb-product', 'collaborators', props.target?.id],
    queryFn: () => listCollaborators(props.target!.id),
    enabled: enabled && props.target?.kind === 'space',
  });
  const acl = useQuery({
    queryKey: ['kb-product', 'acl', props.target?.kind, props.target?.id],
    queryFn: () => getAcl(props.target!.kind, props.target!.id),
    enabled,
  });

  const ownerId = props.space?.ownershipMemberId ?? '';
  const memberDirectory = directory.data?.members ?? [];
  const memberById = useMemo(
    () => new Map(memberDirectory.map((member) => [member.memberId, member])),
    [memberDirectory],
  );

  useEffect(() => {
    if (!props.target) {
      setInitializedTarget('');
      return;
    }
    if (acl.isLoading || collaborators.isLoading || directory.isLoading) return;
    if (props.target.kind === 'space' && collaborators.isLoading) return;
    const targetKey = `${props.target.kind}:${props.target.id}`;
    if (initializedTarget === targetKey) return;
    const entries: DraftEntry[] = [];
    const ownerMember = memberById.get(ownerId);
    if (ownerId) {
      entries.push({
        key: keyOf('member', ownerId),
        principalType: 'member',
        principalId: ownerId,
        name: ownerMember?.name ?? '知识库创建者',
        ...(ownerMember?.avatarUrl ? { avatarUrl: ownerMember.avatarUrl } : {}),
        role: 'owner',
        protected: true,
      });
    }
    for (const collaborator of collaborators.data?.items ?? []) {
      if (collaborator.status !== 'active' || collaborator.memberId === ownerId) continue;
      const member = memberById.get(collaborator.memberId);
      entries.push({
        key: keyOf('member', collaborator.memberId),
        principalType: 'member',
        principalId: collaborator.memberId,
        name: member?.name ?? '未命名成员',
        ...(member?.avatarUrl ? { avatarUrl: member.avatarUrl } : {}),
        role: collaborator.role,
        protected:
          collaborator.memberId === session.data?.memberId ||
          (collaborator.role === 'manage' && !session.data?.isWorkspaceOwner),
        collaborator,
      });
    }
    for (const entry of acl.data?.entries ?? []) {
      if (entry.principalType !== 'group' && entry.principalType !== 'org') continue;
      const unit =
        entry.principalType === 'org'
          ? directory.data?.departments.find((department) => department.id === entry.principalId)
          : directory.data?.groups.find((group) => group.id === entry.principalId);
      entries.push({
        key: keyOf(entry.principalType, entry.principalId),
        principalType: entry.principalType,
        principalId: entry.principalId,
        name: unit?.name ?? (entry.principalType === 'org' ? '未命名部门' : '未命名群组'),
        role: entry.permission,
        protected: entry.permission === 'manage' && !session.data?.isWorkspaceOwner,
      });
    }
    setDraft(entries);
    setInitializedTarget(targetKey);
    setCategory(null);
    setSearch('');
    setError(null);
  }, [
    acl.data,
    acl.isLoading,
    collaborators.data,
    collaborators.isLoading,
    directory.data,
    directory.isLoading,
    initializedTarget,
    memberById,
    ownerId,
    props.target,
    session.data,
  ]);

  const selectedMemberIds = useMemo(
    () =>
      new Set(
        draft.filter((entry) => entry.principalType === 'member').map((entry) => entry.principalId),
      ),
    [draft],
  );
  const selectedUnitIds = useMemo(
    () =>
      new Set(
        draft
          .filter((entry) => entry.principalType !== 'member')
          .map((entry) => keyOf(entry.principalType, entry.principalId)),
      ),
    [draft],
  );
  const normalizedSearch = search.trim().toLocaleLowerCase('zh-CN');

  const shouldShow = (nextCategory: Category) => {
    if (normalizedSearch) return true;
    return category === nextCategory;
  };

  const toggleMember = (memberId: string) => {
    const existing = draft.find(
      (entry) => entry.principalType === 'member' && entry.principalId === memberId,
    );
    if (existing?.protected) return;
    if (existing) {
      setDraft((current) => current.filter((entry) => entry.key !== existing.key));
      return;
    }
    const member = memberById.get(memberId);
    setDraft((current) => [
      ...current,
      {
        key: keyOf('member', memberId),
        principalType: 'member',
        principalId: memberId,
        name: member?.name ?? '未命名成员',
        ...(member?.avatarUrl ? { avatarUrl: member.avatarUrl } : {}),
        role: 'read',
        protected: false,
      },
    ]);
  };

  const toggleUnit = (principalType: 'org' | 'group', principalId: string, name: string) => {
    const key = keyOf(principalType, principalId);
    const existing = draft.find((entry) => entry.key === key);
    if (existing?.protected) return;
    if (existing) {
      setDraft((current) => current.filter((entry) => entry.key !== key));
      return;
    }
    setDraft((current) => [
      ...current,
      {
        key,
        principalType,
        principalId,
        name,
        role: 'read',
        protected: false,
      },
    ]);
  };

  const changeRole = (key: string, role: EditableRole) => {
    setDraft((current) =>
      current.map((entry) => (entry.key === key && !entry.protected ? { ...entry, role } : entry)),
    );
  };

  const removeDraft = (key: string) => {
    setDraft((current) => current.filter((entry) => entry.key !== key || entry.protected));
  };

  const dirty = useMemo(() => {
    const currentCollaborators = new Map(
      (collaborators.data?.items ?? [])
        .filter((entry) => entry.status === 'active' && entry.memberId !== ownerId)
        .map((entry) => [entry.memberId, entry.role]),
    );
    const selectedCollaborators = new Map(
      draft
        .filter((entry) => entry.principalType === 'member' && entry.role !== 'owner')
        .map((entry) => [entry.principalId, entry.role]),
    );
    if (
      currentCollaborators.size !== selectedCollaborators.size ||
      [...selectedCollaborators].some(
        ([memberId, role]) => currentCollaborators.get(memberId) !== role,
      )
    ) {
      return true;
    }
    const currentUnits = new Map(
      (acl.data?.entries ?? [])
        .filter((entry) => entry.principalType === 'group' || entry.principalType === 'org')
        .map((entry) => [keyOf(entry.principalType, entry.principalId), entry.permission]),
    );
    const selectedUnits = new Map(
      draft
        .filter((entry) => entry.principalType !== 'member')
        .map((entry) => [entry.key, entry.role]),
    );
    return (
      currentUnits.size !== selectedUnits.size ||
      [...selectedUnits].some(([key, role]) => currentUnits.get(key) !== role)
    );
  }, [acl.data?.entries, collaborators.data?.items, draft, ownerId]);

  const applyMemberChanges = async (target: CollaboratorTarget) => {
    if (target.kind !== 'space') return;
    const current = new Map(
      (collaborators.data?.items ?? [])
        .filter((entry) => entry.status === 'active' && entry.memberId !== ownerId)
        .map((entry) => [entry.memberId, entry]),
    );
    const desired = new Map(
      draft
        .filter((entry) => entry.principalType === 'member' && entry.role !== 'owner')
        .map((entry) => [entry.principalId, entry.role as EditableRole]),
    );
    for (const [memberId, collaborator] of current) {
      if (!desired.has(memberId)) {
        await removeCollaborator(target.id, collaborator);
      }
    }
    for (const [memberId, role] of desired) {
      const existing = current.get(memberId);
      if (!existing) {
        await addCollaborator(target.id, { memberId, role });
      } else if (existing.role !== role) {
        await updateCollaborator(target.id, existing, role);
      }
    }
    await queryClient.invalidateQueries({
      queryKey: ['kb-product', 'collaborators', target.id],
    });
  };

  const save = async () => {
    const target = props.target;
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    try {
      const currentUnits = new Map(
        (acl.data?.entries ?? [])
          .filter((entry) => entry.principalType === 'group' || entry.principalType === 'org')
          .map((entry) => [keyOf(entry.principalType, entry.principalId), entry.permission]),
      );
      const nextUnits = new Map(
        draft
          .filter((entry) => entry.principalType !== 'member')
          .map((entry) => [entry.key, entry.role]),
      );
      const unitChanged =
        currentUnits.size !== nextUnits.size ||
        [...nextUnits].some(([key, role]) => currentUnits.get(key) !== role);

      await applyMemberChanges(target);

      if (unitChanged || target.kind !== 'space') {
        let expectedVersion = target.version;
        let currentSpace = props.space;
        if (target.kind === 'space') {
          currentSpace = await getSpace(target.id);
          expectedVersion = currentSpace.version;
        } else if (target.kind === 'source') {
          const source = await getSource(target.id);
          currentSpace = await getSpace(source.knowledgeSpaceId);
          if (!currentSpace.sourcePermissionEnabled) {
            currentSpace = await updateSpace(currentSpace.id, {
              version: currentSpace.version,
              sourcePermissionEnabled: true,
            });
          }
          if (acl.data?.permissionState === 'disabled') {
            await transitionSourcePermission(source, 'enable');
          }
          expectedVersion = (await getSource(target.id)).version;
        } else if (currentSpace) {
          const directories = await listDirectories(currentSpace.id);
          const directory = directories.find((entry) => entry.id === target.id);
          if (directory) expectedVersion = directory.version;
        }
        const preservedWorkspaceEntries = (acl.data?.entries ?? []).filter(
          (entry) => entry.principalType === 'workspace',
        );
        const entries = [
          ...draft.map((entry) => ({
            principalType: entry.principalType,
            principalId: entry.principalId,
            permission: entry.role,
          })),
          ...preservedWorkspaceEntries,
        ];
        await updateAcl(
          target.kind,
          target.id,
          {
            inheritMode: 'override',
            entries: [
              ...new Map(
                entries.map((entry) => [keyOf(entry.principalType, entry.principalId), entry]),
              ).values(),
            ],
          },
          expectedVersion,
        );
      }

      await Promise.all([
        target.kind === 'space' ? collaborators.refetch() : Promise.resolve(),
        acl.refetch(),
        queryClient.invalidateQueries({ queryKey: ['kb-product', 'spaces'] }),
        queryClient.invalidateQueries({ queryKey: ['kb-product', 'space', target.id] }),
      ]);
      props.onChanged();
      props.onClose();
    } catch (caught) {
      await Promise.allSettled([
        props.target?.kind === 'space' ? collaborators.refetch() : Promise.resolve(),
        acl.refetch(),
      ]);
      setError(new Error(`协作者保存未全部完成：${messageOf(caught)}`));
    } finally {
      setBusy(false);
    }
  };

  const restoreInheritance = async () => {
    const target = props.target;
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (target.kind === 'source' && target.source) {
        await transitionSourcePermission(target.source, 'resume-inherit');
      } else if (target.kind === 'directory') {
        await resumeAcl(target.kind, target.id, target.version);
      }
      await acl.refetch();
      props.onChanged();
      props.onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const canTransfer =
    props.target?.kind === 'space' &&
    Boolean(ownerId) &&
    (session.data?.isWorkspaceOwner === true || session.data?.memberId === ownerId);
  const transferCandidates = (collaborators.data?.items ?? [])
    .filter(
      (collaborator) =>
        collaborator.status === 'active' &&
        collaborator.role === 'manage' &&
        collaborator.memberId !== ownerId,
    )
    .map((collaborator) => ({
      memberId: collaborator.memberId,
      name: memberById.get(collaborator.memberId)?.name ?? '未命名成员',
    }));

  const transferOwnership = async () => {
    const target = props.target;
    if (target?.kind !== 'space' || !transferMemberId || transferBusy) return;
    setTransferBusy(true);
    setTransferError(null);
    try {
      const latest = await getSpace(target.id);
      await productApi.transferSpaceOwnership(target.id, transferMemberId, latest.version);
      await queryClient.invalidateQueries({ queryKey: ['kb-product', 'spaces'] });
      await queryClient.invalidateQueries({ queryKey: ['kb-product', 'space', target.id] });
      props.onChanged();
      setTransferOpen(false);
      props.onClose();
    } catch (caught) {
      setTransferError(caught);
    } finally {
      setTransferBusy(false);
    }
  };

  const visibleMembers = memberDirectory.filter((member) => {
    if (!shouldShow('member')) return false;
    return !normalizedSearch || member.name.toLocaleLowerCase('zh-CN').includes(normalizedSearch);
  });
  const visibleDepartments = (directory.data?.departments ?? []).filter((department) => {
    if (!shouldShow('department')) return false;
    return (
      !normalizedSearch || department.name.toLocaleLowerCase('zh-CN').includes(normalizedSearch)
    );
  });
  const visibleGroups = (directory.data?.groups ?? []).filter((group) => {
    if (!shouldShow('group')) return false;
    return !normalizedSearch || group.name.toLocaleLowerCase('zh-CN').includes(normalizedSearch);
  });
  const canRestore =
    acl.data?.permissionState === 'independent' &&
    (props.target?.kind === 'source' || props.target?.kind === 'directory');

  return (
    <>
      <ProductModal
        open={Boolean(props.target)}
        title="管理协作者"
        description={props.target?.name}
        size="xl"
        onClose={() => !busy && props.onClose()}
        footer={
          <>
            {canRestore ? (
              <ProductButton busy={busy} onClick={() => void restoreInheritance()}>
                <RepeatIcon boxSize={3.5} />
                恢复知识库继承
              </ProductButton>
            ) : null}
            {canTransfer ? (
              <ProductButton
                onClick={() => {
                  setTransferMemberId('');
                  setTransferError(null);
                  setTransferOpen(true);
                }}
                disabled={busy}
              >
                转移所有权
              </ProductButton>
            ) : null}
            <ProductButton onClick={props.onClose} disabled={busy}>
              取消
            </ProductButton>
            <ProductButton
              tone="primary"
              busy={busy}
              disabled={!dirty || acl.isLoading || directory.isLoading}
              onClick={() => void save()}
            >
              确认
            </ProductButton>
          </>
        }
      >
        <ProductError error={error ?? acl.error ?? collaborators.error ?? directory.error} />
        {props.target?.kind === 'source' && !props.space?.sourcePermissionEnabled ? (
          <div className="kb2-note">
            确认后将为当前文件启用独立协作者权限，未单独设置的文件仍继承知识库协作者。
          </div>
        ) : null}
        <div className="kb2-collaborator-layout">
          <section className="kb2-collaborator-picker" aria-label="选择协作者">
            <label className="kb2-collaborator-search">
              <SearchIcon boxSize={4} />
              <ProductInput
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索成员、部门或群组名称"
                aria-label="搜索成员、部门或群组"
              />
            </label>
            {!normalizedSearch && !category ? (
              <div className="kb2-collaborator-categories">
                {[
                  ['member', '成员', memberDirectory.length],
                  ['department', '部门', directory.data?.departments.length ?? 0],
                  ['group', '群组', directory.data?.groups.length ?? 0],
                ].map(([value, label, count]) => (
                  <button key={value} type="button" onClick={() => setCategory(value as Category)}>
                    <span>{label}</span>
                    <small>{count} 项</small>
                    <ChevronRightIcon />
                  </button>
                ))}
              </div>
            ) : null}
            {category || normalizedSearch ? (
              <div className="kb2-collaborator-path">
                <button type="button" onClick={() => setCategory(null)}>
                  团队
                </button>
                {!normalizedSearch && category ? (
                  <>
                    <ChevronRightIcon />
                    <strong>
                      {category === 'member' ? '成员' : category === 'department' ? '部门' : '群组'}
                    </strong>
                  </>
                ) : null}
              </div>
            ) : null}
            <div className="kb2-collaborator-list">
              {visibleMembers.map((member) => {
                const checked = selectedMemberIds.has(member.memberId);
                const protectedMember = draft.find(
                  (entry) =>
                    entry.principalType === 'member' && entry.principalId === member.memberId,
                )?.protected;
                return (
                  <button
                    key={member.memberId}
                    type="button"
                    className={checked ? 'is-selected' : ''}
                    disabled={protectedMember}
                    onClick={() => toggleMember(member.memberId)}
                  >
                    <span className="kb2-collaborator-avatar">
                      {member.avatarUrl ? (
                        <img src={member.avatarUrl} alt="" />
                      ) : (
                        member.name.slice(0, 1)
                      )}
                    </span>
                    <strong>{member.name}</strong>
                    <span aria-hidden="true">{checked ? '✓' : ''}</span>
                  </button>
                );
              })}
              {visibleDepartments.map((department) => {
                const key = keyOf('org', department.id);
                return (
                  <button
                    key={key}
                    type="button"
                    className={selectedUnitIds.has(key) ? 'is-selected' : ''}
                    onClick={() => toggleUnit('org', department.id, department.name)}
                  >
                    <span className="kb2-collaborator-avatar">部</span>
                    <strong>{department.name}</strong>
                    <span aria-hidden="true">{selectedUnitIds.has(key) ? '✓' : ''}</span>
                  </button>
                );
              })}
              {visibleGroups.map((group) => {
                const key = keyOf('group', group.id);
                return (
                  <button
                    key={key}
                    type="button"
                    className={selectedUnitIds.has(key) ? 'is-selected' : ''}
                    onClick={() => toggleUnit('group', group.id, group.name)}
                  >
                    <span className="kb2-collaborator-avatar">组</span>
                    <strong>{group.name}</strong>
                    <span aria-hidden="true">{selectedUnitIds.has(key) ? '✓' : ''}</span>
                  </button>
                );
              })}
              {(normalizedSearch || category) &&
              visibleMembers.length + visibleDepartments.length + visibleGroups.length === 0 ? (
                <div className="kb2-table-muted">
                  {directory.isLoading ? '正在读取目录…' : '没有匹配的成员、部门或群组'}
                </div>
              ) : null}
            </div>
          </section>
          <section className="kb2-collaborator-selected" aria-label="已选协作者">
            <div className="kb2-collaborator-selected__head">
              <strong>已选：{draft.length}</strong>
              <span>确认后统一保存</span>
            </div>
            <div className="kb2-collaborator-cards">
              {draft.map((entry) => (
                <div className="kb2-collaborator-card" key={entry.key}>
                  <span className="kb2-collaborator-avatar">
                    {entry.avatarUrl ? (
                      <img src={entry.avatarUrl} alt="" />
                    ) : (
                      entry.name.slice(0, 1)
                    )}
                  </span>
                  <div>
                    <strong>{entry.name}</strong>
                    <small>
                      {entry.principalType === 'org'
                        ? '部门'
                        : entry.principalType === 'group'
                          ? '群组'
                          : '成员'}
                    </small>
                  </div>
                  {entry.role === 'owner' ? (
                    <StatusTag value="创建者" tone="purple" />
                  ) : (
                    <ProductSelect
                      value={entry.role}
                      disabled={entry.protected || busy}
                      aria-label={`${entry.name} 的角色`}
                      onChange={(event) =>
                        changeRole(entry.key, event.target.value as EditableRole)
                      }
                    >
                      {Object.entries(ROLE_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </ProductSelect>
                  )}
                  <ProductIconButton
                    label={`移除 ${entry.name}`}
                    tone="danger"
                    disabled={entry.protected || busy}
                    onClick={() => removeDraft(entry.key)}
                  >
                    <DeleteIcon boxSize={3.5} />
                  </ProductIconButton>
                </div>
              ))}
            </div>
          </section>
        </div>
      </ProductModal>
      <ProductModal
        open={transferOpen}
        title="转移所有权"
        description="转移后你将不再是该知识库的创建者。"
        onClose={() => !transferBusy && setTransferOpen(false)}
        footer={
          <>
            <ProductButton onClick={() => setTransferOpen(false)} disabled={transferBusy}>
              取消
            </ProductButton>
            <ProductButton
              tone="danger"
              busy={transferBusy}
              disabled={!transferMemberId}
              onClick={() => void transferOwnership()}
            >
              确认转移所有权
            </ProductButton>
          </>
        }
      >
        <ProductError error={transferError} />
        <ProductField label="新所有者">
          <ProductSelect
            value={transferMemberId}
            onChange={(event) => setTransferMemberId(event.target.value)}
            disabled={transferCandidates.length === 0}
          >
            <option value="">
              {transferCandidates.length === 0 ? '暂无满足条件的可管理成员' : '选择可管理成员'}
            </option>
            {transferCandidates.map((entry) => (
              <option key={entry.memberId} value={entry.memberId}>
                {entry.name}
              </option>
            ))}
          </ProductSelect>
        </ProductField>
      </ProductModal>
    </>
  );
}
