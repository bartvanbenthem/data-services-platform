import { useApi, useRouteRef } from '@backstage/frontend-plugin-api';
import { usePermission } from '@backstage/plugin-permission-react';
import {
  Alert,
  ButtonLink,
  Container,
  Flex,
  Grid,
  Header,
  NumberField,
  Select,
  Switch,
  TextField,
} from '@backstage/ui';
import { cnpgProjectCreatePermission } from '@internal/backstage-plugin-cnpg-common';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import useAsync from 'react-use/esm/useAsync';
import { stringify } from 'yaml';
import { cnpgApiRef } from '../api';
import { clusterRouteRef, createProjectRouteRef } from '../routes';
import { ManifestPanel, Section } from './common';
import { ClusterForm, defaultForm, toManifest, toSpec, validate } from './form';

const opts = (values: Array<string | number>) => values.map(v => ({ id: String(v), label: String(v) }));

export const CreateClusterPage = () => {
  const api = useApi(cnpgApiRef);
  const navigate = useNavigate();
  const clusterLink = useRouteRef(clusterRouteRef);
  const createProjectLink = useRouteRef(createProjectRouteRef);
  const { allowed: canCreateProject } = usePermission({ permission: cnpgProjectCreatePermission });
  const [params] = useSearchParams();

  const { value: config } = useAsync(() => api.getConfig(), [api]);
  // Clusters go into a Project namespace, which comes with its own
  // Prometheus and Grafana; free-text namespaces are no longer offered.
  const { value: projects, loading: projectsLoading } = useAsync(() => api.listProjects(), [api]);

  // ?project=<name> (from a project page) wins over the configured default.
  const [form, setForm] = useState<ClusterForm>(defaultForm(params.get('project') ?? ''));
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState<'validate' | 'create'>();
  const [result, setResult] = useState<{ error?: Error; validated?: boolean }>({});

  useEffect(() => {
    const preferred = config?.defaultNamespace;
    if (preferred && projects?.some(p => p.name === preferred)) {
      setForm(f => (f.namespace ? f : { ...f, namespace: preferred }));
    }
  }, [config, projects]);

  /** Selecting a project also suggests its owner, unless one was typed already. */
  const selectProject = (name: string) => {
    const project = projects?.find(p => p.name === name);
    setForm(f => ({ ...f, namespace: name, owner: f.owner || project?.owner || '' }));
    setResult({});
  };

  const set = <K extends keyof ClusterForm>(key: K) => (value: ClusterForm[K]) => {
    setForm(f => ({ ...f, [key]: value }));
    setResult({});
  };

  const errors = useMemo(() => validate(form), [form]);
  const err = (key: keyof ClusterForm) => (touched ? errors[key] : undefined);
  const manifest = useMemo(() => stringify(toManifest(form)), [form]);

  const submit = async (dryRun: boolean) => {
    setTouched(true);
    if (Object.keys(errors).length) return;
    setSubmitting(dryRun ? 'validate' : 'create');
    setResult({});
    try {
      await api.createCluster({
        name: form.name,
        namespace: form.namespace,
        owner: form.owner || undefined,
        spec: toSpec(form),
        dryRun,
      });
      if (dryRun) {
        setResult({ validated: true });
      } else {
        navigate(clusterLink?.({ namespace: form.namespace, name: form.name }) ?? '/cnpg');
      }
    } catch (e) {
      setResult({ error: e as Error });
    } finally {
      setSubmitting(undefined);
    }
  };

  const storageClasses = config?.storageClasses ?? [];

  return (
    <>
      <Header
        title="Create PostgreSQL cluster"
      />
      <Container>
        <Grid.Root columns={{ initial: '1', lg: '3' }} gap="4">
          <Grid.Item colSpan={{ initial: '1', lg: '2' }}>
            <Flex direction="column" gap="4">
              {!projectsLoading && projects?.length === 0 && (
                <Alert
                  status="info"
                  title="No projects yet"
                  description="A cluster lives in a project, which comes with its own Prometheus and Grafana. Create a project first."
                  customActions={
                    canCreateProject && createProjectLink ? (
                      <ButtonLink href={createProjectLink()} variant="secondary" size="small">
                        Create project
                      </ButtonLink>
                    ) : undefined
                  }
                />
              )}
              <Section title="Basics">
                <TextField
                  label="Name"
                  isRequired
                  value={form.name}
                  onChange={set('name')}
                  description={err('name') ?? 'Also the prefix of every Kubernetes object it creates.'}
                  isInvalid={Boolean(err('name'))}
                />
                <Select
                  label="Project"
                  isRequired
                  searchable
                  value={form.namespace || null}
                  onChange={k => selectProject(String(k ?? ''))}
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
                <Select
                  label="PostgreSQL version"
                  value={String(form.postgresVersion)}
                  onChange={k => set('postgresVersion')(Number(k))}
                  options={opts([18, 17, 16, 15, 14])}
                  description="Major version; minor updates roll out with the image catalog."
                />
                <NumberField
                  label="Instances"
                  minValue={1}
                  maxValue={9}
                  value={form.instances}
                  onChange={set('instances')}
                  description="1 primary + hot standbys. Use 3 for production."
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
                  value={form.databaseName}
                  onChange={v => setForm(f => ({ ...f, databaseName: v, databaseOwner: v }))}
                  description={err('databaseName') ?? 'Created at bootstrap; credentials go to <name>-app.'}
                  isInvalid={Boolean(err('databaseName'))}
                />
              </Section>

              <Section title="Storage & resources" description="Per instance.">
                <TextField
                  label="Data volume size"
                  value={form.storageSize}
                  onChange={set('storageSize')}
                  description={err('storageSize') ?? 'Can grow later if the StorageClass allows expansion.'}
                  isInvalid={Boolean(err('storageSize'))}
                />
                {storageClasses.length > 0 ? (
                  <Select
                    label="StorageClass"
                    value={form.storageClass || '__default__'}
                    onChange={k => set('storageClass')(k === '__default__' ? '' : String(k))}
                    options={[{ id: '__default__', label: 'cluster default' }, ...opts(storageClasses)]}
                  />
                ) : (
                  <TextField
                    label="StorageClass"
                    value={form.storageClass}
                    onChange={set('storageClass')}
                    placeholder="cluster default"
                  />
                )}
                <Switch
                  label="Separate WAL volume"
                  isSelected={form.walEnabled}
                  onChange={set('walEnabled')}
                />
                {form.walEnabled && (
                  <TextField
                    label="WAL volume size"
                    value={form.walSize}
                    onChange={set('walSize')}
                    description={err('walSize')}
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
            </Flex>
          </Grid.Item>

          <Grid.Item>
            <ManifestPanel
              manifest={manifest}
              hasErrors={touched && Object.keys(errors).length > 0}
              error={result.error}
              validated={result.validated}
              submitting={submitting}
              onSubmit={submit}
              createLabel="Create cluster"
            />
          </Grid.Item>
        </Grid.Root>
      </Container>
    </>
  );
};
