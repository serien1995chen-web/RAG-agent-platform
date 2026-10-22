import {
  Field,
  FormBand,
  PageHeader,
  ProblemNotice,
  SelectInput,
  TextArea,
  TextInput,
  knowledgeRequest,
} from '@kb/web';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useState, type FormEvent } from 'react';
import type { SpaceRecord } from '../../lib/knowledge-types';

export default function NewSpacePage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState<'space' | 'folder'>('space');
  const [accessMode, setAccessMode] = useState<'workspace' | 'restricted'>('workspace');
  const [sourceAclMode, setSourceAclMode] = useState<'inherited' | 'enforced'>('enforced');
  const [sourcePermissionEnabled, setSourcePermissionEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const space = await knowledgeRequest<SpaceRecord>('/v1/knowledge/spaces', {
        method: 'POST',
        body: {
          kind,
          name,
          description,
          iconKey: 'book-open',
          accessMode,
          sourceAclMode,
          sourcePermissionEnabled,
        },
      });
      await router.push(`/spaces/${space.id}/overview`);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Head>
        <title>New knowledge space</title>
      </Head>
      <PageHeader
        eyebrow="Knowledge catalog"
        title="New space"
        description="Create a Knowledge Space or an organization folder."
      />
      <ProblemNotice error={error} />
      <FormBand
        title="Basics"
        description="Names are unique among siblings. Access and Source policy are recorded at creation."
        submitLabel="Create space"
        busy={busy}
        onSubmit={submit}
      >
        <Field label="Type">
          <SelectInput
            value={kind}
            onChange={(event) => setKind(event.target.value as 'space' | 'folder')}
          >
            <option value="space">Knowledge Space</option>
            <option value="folder">Organization folder</option>
          </SelectInput>
        </Field>
        <Field label="Name">
          <TextInput
            required
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="Description">
          <TextArea
            maxLength={2000}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        <Field label="Space access">
          <SelectInput
            value={accessMode}
            onChange={(event) => setAccessMode(event.target.value as 'workspace' | 'restricted')}
          >
            <option value="workspace">Workspace members</option>
            <option value="restricted">Restricted by ACL</option>
          </SelectInput>
        </Field>
        <Field label="Source ACL policy">
          <SelectInput
            value={sourceAclMode}
            onChange={(event) => setSourceAclMode(event.target.value as 'inherited' | 'enforced')}
          >
            <option value="enforced">Allow Source-level permissions</option>
            <option value="inherited">Force inheritance</option>
          </SelectInput>
        </Field>
        <label className="checkbox-row full">
          <input
            type="checkbox"
            checked={sourcePermissionEnabled}
            onChange={(event) => setSourcePermissionEnabled(event.target.checked)}
          />
          Source-level permissions enabled
        </label>
      </FormBand>
    </>
  );
}
