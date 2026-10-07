import { Switch, Text, TextField } from '@backstage/ui';
import type { Project } from '@internal/backstage-plugin-cnpg-common';
import { Section } from './common';
import { ProjectForm } from './projectForm';

/**
 * Every section of the project form, shared by the create and edit pages.
 * With `original` (edit mode) the name is read-only and the Prometheus
 * volume says it can only grow. `lockedAccess` is an access list the form
 * can't represent; it's shown, not edited.
 */
export const ProjectFormFields = ({
  form,
  setForm,
  err,
  original,
  lockedAccess,
}: {
  form: ProjectForm;
  setForm: (update: (f: ProjectForm) => ProjectForm) => void;
  err: (key: keyof ProjectForm) => string | undefined;
  original?: ProjectForm;
  lockedAccess?: Project['spec']['access'];
}) => {
  const editing = Boolean(original);
  const set = <K extends keyof ProjectForm>(key: K) => (value: ProjectForm[K]) =>
    setForm(f => ({ ...f, [key]: value }));

  return (
    <>
      <Section title="Basics">
        <TextField
          label="Name"
          isRequired
          isDisabled={editing}
          value={form.name}
          onChange={set('name')}
          description={
            err('name') ??
            (editing
              ? 'The namespace name; fixed after creation.'
              : 'Lowercase letters, digits and single "-", max 40 characters.')
          }
          isInvalid={Boolean(err('name'))}
        />
        <TextField
          label="Owner (group)"
          value={form.owner}
          onChange={set('owner')}
          description={err('owner') ?? 'Catalog owner of the project and, by default, its databases.'}
          isInvalid={Boolean(err('owner'))}
        />
        <TextField
          label="Description"
          value={form.description}
          onChange={set('description')}
          description={err('description')}
          isInvalid={Boolean(err('description'))}
        />
      </Section>

      <Section
        title="Access"
        description="Kubernetes groups from your identity provider that get access to the project."
      >
        {lockedAccess ? (
          <Text variant="body-small" color="secondary">
            {lockedAccess.map(a => `${a.group} (${a.role})`).join(', ')}. This list has
            more entries than the form can show; change it with kubectl.
          </Text>
        ) : (
          <>
            <TextField
              label="Group with edit access"
              value={form.editGroup}
              onChange={set('editGroup')}
              description='Built-in "edit" role: manage PostgresClusters, read Secrets.'
            />
            <TextField
              label="Group with view access"
              value={form.viewGroup}
              onChange={set('viewGroup')}
              description='Built-in "view" role.'
            />
          </>
        )}
      </Section>

      <Section title="Quota" description="Caps on what the whole project may request.">
        <Switch
          label="Limit total resources"
          isSelected={form.quotaEnabled}
          onChange={set('quotaEnabled')}
        />
        {form.quotaEnabled && (
          <>
            <TextField
              label="CPU requests"
              value={form.quotaCpu}
              onChange={set('quotaCpu')}
              description={err('quotaCpu')}
              isInvalid={Boolean(err('quotaCpu'))}
            />
            <TextField
              label="Memory"
              value={form.quotaMemory}
              onChange={set('quotaMemory')}
              description={err('quotaMemory')}
              isInvalid={Boolean(err('quotaMemory'))}
            />
            <TextField
              label="Storage"
              value={form.quotaStorage}
              onChange={set('quotaStorage')}
              description={
                err('quotaStorage') ??
                (editing
                  ? 'All PVCs together, including Prometheus. Raise it before growing volumes.'
                  : 'All PVCs together, including Prometheus.')
              }
              isInvalid={Boolean(err('quotaStorage'))}
            />
          </>
        )}
      </Section>

      <Section
        title="Observability"
        description="Every PostgreSQL cluster in the project reports to this Prometheus and gets its dashboard in this Grafana."
      >
        <TextField
          label="Metrics retention"
          value={form.prometheusRetention}
          onChange={set('prometheusRetention')}
          description={err('prometheusRetention')}
          isInvalid={Boolean(err('prometheusRetention'))}
        />
        <TextField
          label="Prometheus volume size"
          value={form.prometheusStorage}
          onChange={set('prometheusStorage')}
          description={
            err('prometheusStorage') ??
            (editing
              ? `Grows online if the StorageClass allows expansion; can't shrink (now ${original!.prometheusStorage}).`
              : undefined)
          }
          isInvalid={Boolean(err('prometheusStorage'))}
        />
        <Switch
          label="Expose Grafana through the cluster ingress"
          isSelected={form.grafanaIngress}
          onChange={set('grafanaIngress')}
        />
      </Section>
    </>
  );
};
