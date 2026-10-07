import { NumberField, Select, Switch, TextField } from '@backstage/ui';
import type { ProjectSummary } from '@internal/backstage-plugin-cnpg-common';
import { Section } from './common';
import { ClusterForm } from './form';

const opts = (values: Array<string | number>) => values.map(v => ({ id: String(v), label: String(v) }));

/** Explains a field the edit form shows read-only. */
const FIXED = 'Fixed after creation.';

/**
 * Every section of the cluster form, shared by the create and edit pages.
 * With `original` (edit mode) the fields that would need a new cluster are
 * read-only, and volumes say they can only grow.
 */
export const ClusterFormFields = ({
  form,
  setForm,
  err,
  storageClasses,
  projects,
  onSelectProject,
  original,
}: {
  form: ClusterForm;
  setForm: (update: (f: ClusterForm) => ClusterForm) => void;
  err: (key: keyof ClusterForm) => string | undefined;
  storageClasses: string[];
  projects?: ProjectSummary[];
  onSelectProject?: (name: string) => void;
  original?: ClusterForm;
}) => {
  const editing = Boolean(original);
  const set = <K extends keyof ClusterForm>(key: K) => (value: ClusterForm[K]) =>
    setForm(f => ({ ...f, [key]: value }));

  let storageClassField;
  if (editing) {
    storageClassField = (
      <TextField
        label="StorageClass"
        isDisabled
        value={form.storageClass || 'cluster default'}
        description={FIXED}
      />
    );
  } else if (storageClasses.length > 0) {
    storageClassField = (
      <Select
        label="StorageClass"
        value={form.storageClass || '__default__'}
        onChange={k => set('storageClass')(k === '__default__' ? '' : String(k))}
        options={[{ id: '__default__', label: 'cluster default' }, ...opts(storageClasses)]}
      />
    );
  } else {
    storageClassField = (
      <TextField
        label="StorageClass"
        value={form.storageClass}
        onChange={set('storageClass')}
        placeholder="cluster default"
      />
    );
  }

  return (
    <>
      <Section title="Basics">
        <TextField
          label="Name"
          isRequired
          isDisabled={editing}
          value={form.name}
          onChange={set('name')}
          description={err('name') ?? (editing ? FIXED : 'Also the prefix of every Kubernetes object it creates.')}
          isInvalid={Boolean(err('name'))}
        />
        {editing ? (
          <TextField label="Project" isDisabled value={form.namespace} description={FIXED} />
        ) : (
          <Select
            label="Project"
            isRequired
            searchable
            value={form.namespace || null}
            onChange={k => onSelectProject?.(String(k ?? ''))}
            options={(projects ?? []).map(p => ({
              id: p.name,
              label: p.ready ? p.name : `${p.name} (provisioning)`,
            }))}
            description={
              err('namespace') ??
              "Its metrics, alerts and dashboard go to the project's Prometheus and Grafana."
            }
            isInvalid={Boolean(err('namespace'))}
          />
        )}
        <Select
          label="PostgreSQL version"
          isDisabled={editing}
          value={String(form.postgresVersion)}
          onChange={k => set('postgresVersion')(Number(k))}
          options={opts([18, 17, 16, 15, 14])}
          description={
            editing
              ? 'A major upgrade restarts the whole cluster; run it with kubectl.'
              : 'Major version; minor updates roll out with the image catalog.'
          }
        />
        <NumberField
          label="Instances"
          minValue={1}
          maxValue={9}
          value={form.instances}
          onChange={set('instances')}
          description={
            editing
              ? 'Standbys are added or removed one by one; the primary stays up.'
              : '1 primary + hot standbys. Use 3 for production.'
          }
        />
        <TextField
          label="Owner (group)"
          value={form.owner}
          onChange={set('owner')}
          description={err('owner') ?? 'Catalog owner, e.g. team-payments.'}
          isInvalid={Boolean(err('owner'))}
        />
        <TextField
          label="Database / owner role"
          isDisabled={editing}
          value={form.databaseName}
          onChange={v => setForm(f => ({ ...f, databaseName: v, databaseOwner: v }))}
          description={
            err('databaseName') ??
            (editing ? FIXED : 'Created at bootstrap; credentials go to <name>-app.')
          }
          isInvalid={Boolean(err('databaseName'))}
        />
      </Section>

      <Section
        title="Storage & resources"
        description={
          editing
            ? 'Per instance. Volumes grow online if the StorageClass allows expansion; CPU and memory changes restart the instances one by one, the primary last (switchover).'
            : 'Per instance.'
        }
      >
        <TextField
          label="Data volume size"
          value={form.storageSize}
          onChange={set('storageSize')}
          description={
            err('storageSize') ??
            (editing ? `Can grow, not shrink (now ${original!.storageSize}).` : 'Can grow later if the StorageClass allows expansion.')
          }
          isInvalid={Boolean(err('storageSize'))}
        />
        {storageClassField}
        <Switch
          label={editing && !form.walEnabled ? 'Separate WAL volume (only at creation)' : 'Separate WAL volume'}
          isDisabled={editing}
          isSelected={form.walEnabled}
          onChange={set('walEnabled')}
        />
        {form.walEnabled && (
          <TextField
            label="WAL volume size"
            value={form.walSize}
            onChange={set('walSize')}
            description={err('walSize') ?? (editing ? `Can grow, not shrink (now ${original!.walSize}).` : undefined)}
            isInvalid={Boolean(err('walSize'))}
          />
        )}
        <TextField label="CPU request" value={form.cpu} onChange={set('cpu')} />
        <TextField
          label="Memory (request = limit)"
          value={form.memory}
          onChange={set('memory')}
        />
      </Section>

      <Section title="High availability">
        <Select
          label="Pod anti-affinity"
          value={form.podAntiAffinityType}
          onChange={k => set('podAntiAffinityType')(k as ClusterForm['podAntiAffinityType'])}
          options={[
            { id: 'preferred', label: 'preferred (best effort)' },
            { id: 'required', label: 'required (one instance per node)' },
          ]}
        />
        <NumberField
          label="Synchronous replicas"
          minValue={0}
          maxValue={Math.max(form.instances - 1, 0)}
          value={form.synchronousReplicas}
          onChange={set('synchronousReplicas')}
          description={err('synchronousReplicas') ?? '0 = asynchronous replication.'}
          isInvalid={Boolean(err('synchronousReplicas'))}
        />
        <Switch
          label="Spread across zones"
          isSelected={form.zoneSpread}
          onChange={set('zoneSpread')}
        />
        {form.synchronousReplicas > 0 && (
          <Select
            label="When no sync standby is available"
            value={form.synchronousDataDurability}
            onChange={k =>
              set('synchronousDataDurability')(k as ClusterForm['synchronousDataDurability'])
            }
            options={[
              { id: 'preferred', label: 'keep accepting writes (preferred)' },
              { id: 'required', label: 'block writes (required)' },
            ]}
          />
        )}
      </Section>

      <Section title="Connection pooling" description="PgBouncer in front of the cluster.">
        <Switch
          label="Enable PgBouncer"
          isSelected={form.poolerEnabled}
          onChange={set('poolerEnabled')}
        />
        {form.poolerEnabled && (
          <>
            <Select
              label="Pool mode"
              value={form.poolMode}
              onChange={k => set('poolMode')(k as ClusterForm['poolMode'])}
              options={opts(['transaction', 'session'])}
            />
            <NumberField
              label="Pooler instances"
              minValue={1}
              maxValue={10}
              value={form.poolerInstances}
              onChange={set('poolerInstances')}
            />
            <Switch
              label="Also pool the read-only service"
              isSelected={form.poolerReadOnly}
              onChange={set('poolerReadOnly')}
            />
          </>
        )}
      </Section>

      <Section
        title="Backups"
        description="Continuous WAL archiving and scheduled base backups to S3-compatible storage."
      >
        <Switch
          label="Enable backups"
          isSelected={form.backupEnabled}
          onChange={set('backupEnabled')}
        />
        {form.backupEnabled && (
          <>
            <TextField
              label="Destination"
              placeholder="s3://bucket/path"
              value={form.backupDestinationPath}
              onChange={set('backupDestinationPath')}
              description={err('backupDestinationPath')}
              isInvalid={Boolean(err('backupDestinationPath'))}
            />
            <TextField
              label="Endpoint URL"
              placeholder="https://object.storage.example.com"
              value={form.backupEndpointURL}
              onChange={set('backupEndpointURL')}
              description="Leave empty for AWS S3."
            />
            <TextField
              label="Credentials Secret"
              value={form.backupSecretName}
              onChange={set('backupSecretName')}
              description={err('backupSecretName') ?? 'Keys ACCESS_KEY_ID and ACCESS_SECRET_KEY, in the same project.'}
              isInvalid={Boolean(err('backupSecretName'))}
            />
            <TextField
              label="Retention"
              value={form.backupRetention}
              onChange={set('backupRetention')}
              description={err('backupRetention')}
              isInvalid={Boolean(err('backupRetention'))}
            />
            <TextField
              label="Schedule"
              value={form.backupSchedule}
              onChange={set('backupSchedule')}
              description={err('backupSchedule') ?? 'Six-field cron, seconds first.'}
              isInvalid={Boolean(err('backupSchedule'))}
            />
          </>
        )}
      </Section>

      <Section title="Monitoring">
        <Switch
          label="Prometheus metrics & alerts"
          isSelected={form.monitoringEnabled}
          onChange={set('monitoringEnabled')}
        />
        <Switch
          label="Grafana dashboard"
          isSelected={form.dashboardEnabled}
          onChange={set('dashboardEnabled')}
        />
      </Section>
    </>
  );
};
