import { NumberField, Select, Switch, Text, TextField } from '@backstage/ui';
import type { ProjectSummary } from '@internal/backstage-plugin-cnpg-common';
import { Section } from './common';
import { ClusterForm } from './form';

const opts = (values: Array<string | number>) => values.map(v => ({ id: String(v), label: String(v) }));

/** Explains a field the edit form shows read-only. */
const FIXED = 'Fixed after creation.';

/** The project's two sites; a cluster runs in the protected one and, with geo replication, the recovery one. */
export interface Sites {
  protected?: string;
  recovery?: string;
}

/** "protected (dc-ams)": the site and the location behind it. */
export const siteLabel = (site: keyof Sites, sites?: Sites) =>
  sites?.[site] ? `${site} (${sites[site]})` : site;

/**
 * Every section of the cluster form, shared by the create and edit pages.
 * With `original` (edit mode) the fields that would need a new cluster are
 * read-only, and volumes say they can only grow. `sites` are the project's
 * locations (in create mode they come from the selected project).
 */
export const ClusterFormFields = ({
  form,
  setForm,
  err,
  storageClasses,
  projects,
  onSelectProject,
  original,
  sites: sitesProp,
  backupBucket: backupBucketProp,
}: {
  form: ClusterForm;
  setForm: (update: (f: ClusterForm) => ClusterForm) => void;
  err: (key: keyof ClusterForm) => string | undefined;
  storageClasses: string[];
  projects?: ProjectSummary[];
  onSelectProject?: (name: string) => void;
  original?: ClusterForm;
  sites?: Sites;
  /** The project's COSI backup bucket, if it has one (in create mode from the selected project). */
  backupBucket?: ProjectSummary['backupBucket'];
}) => {
  const editing = Boolean(original);
  const set = <K extends keyof ClusterForm>(key: K) => (value: ClusterForm[K]) =>
    setForm(f => ({ ...f, [key]: value }));

  const project = projects?.find(p => p.name === form.namespace);
  const sites: Sites | undefined =
    sitesProp ?? (project && { protected: project.protectedLocation, recovery: project.recoveryLocation });
  const bucket = backupBucketProp ?? project?.backupBucket;
  // Moving a running cluster's WAL archive would cut off its replica cluster.
  const storeFixed = editing && original!.backupEnabled;
  // Geo replication off while the primary is in the recovery site: the
  // composition switches it back first, then removes the replica cluster.
  const draining = editing && original!.geoReplication && !form.geoReplication;
  let geoHelp = 'The project has no recovery location; add one to the project first.';
  if (sites?.recovery) {
    geoHelp =
      draining && original!.primarySite === 'recovery'
        ? `Switches the primary back to ${sites.protected} first, then removes the replica cluster.`
        : 'Needs backups: the replica cluster replays the WAL archive, so the sites need no network path to each other.';
  }

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
        title="Sites"
        description="The control plane runs no databases: the cluster runs in its project's protected location. With geo replication a replica cluster in the recovery location follows it through the backup object store, ready to take over."
      >
        <TextField
          label="Protected location"
          isDisabled
          value={sites?.protected ?? (form.namespace ? 'none: the project has no protected location' : 'pick a project')}
          description="Where the database runs: the project's protected location."
        />
        <Switch
          label={sites?.recovery ? `Geo replication to ${sites.recovery}` : 'Geo replication'}
          isSelected={form.geoReplication}
          isDisabled={!sites?.recovery && !form.geoReplication}
          onChange={on =>
            setForm(f => ({ ...f, geoReplication: on, ...(on ? {} : { primarySite: 'protected' as const }) }))
          }
        />
        <Text variant="body-small" color={err('geoReplication') ? 'danger' : 'secondary'}>
          {err('geoReplication') ?? geoHelp}
        </Text>
        {form.geoReplication && (
          <NumberField
            label="Replica cluster instances"
            minValue={0}
            maxValue={9}
            value={form.geoInstances}
            onChange={set('geoInstances')}
            description={err('geoInstances') ?? '0: as many as the cluster has.'}
            isInvalid={Boolean(err('geoInstances'))}
          />
        )}
        {editing && original!.geoReplication && (
          <TextField
            label="Primary site"
            isDisabled
            value={siteLabel(original!.primarySite, sites)}
            description="Switch over or fail over from the cluster's Disaster recovery tab."
          />
        )}
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
          onChange={on =>
            setForm(f => ({
              ...f,
              backupEnabled: on,
              // The project's bucket, unless a destination was typed already.
              ...(on && bucket && !storeFixed && !f.backupDestinationPath ? { backupProjectBucket: true } : {}),
            }))
          }
        />
        {form.backupEnabled && (bucket || form.backupProjectBucket) && (
          <Switch
            label={bucket?.bucket ? `Store in the project's bucket (${bucket.bucket})` : "Store in the project's bucket"}
            isSelected={form.backupProjectBucket}
            isDisabled={storeFixed}
            onChange={set('backupProjectBucket')}
          />
        )}
        {form.backupEnabled && form.backupProjectBucket && (
          <Text variant="body-small" color={bucket ? 'secondary' : 'warning'}>
            {storeFixed && "Fixed: moving a running cluster's WAL archive would cut off its replica cluster. "}
            {bucket
              ? `COSI provisioned it for the project; each site gets credentials of its own.${bucket.ready ? '' : ' Still provisioning: the cluster waits for it.'}`
              : 'The project has no backup bucket; turn this off and give a destination of your own.'}
          </Text>
        )}
        {form.backupEnabled && (
          <>
            {!form.backupProjectBucket && (
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
              </>
            )}
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
