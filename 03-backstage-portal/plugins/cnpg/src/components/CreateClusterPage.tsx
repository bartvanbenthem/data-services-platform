import { useApi, useRouteRef } from '@backstage/frontend-plugin-api';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  Container,
  Flex,
  Grid,
  Header,
  NumberField,
  Select,
  Switch,
  Text,
  TextField,
} from '@backstage/ui';
import { ReactNode, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import useAsync from 'react-use/esm/useAsync';
import { stringify } from 'yaml';
import { cnpgApiRef } from '../api';
import { clusterRouteRef } from '../routes';
import { ErrorAlert } from './common';
import { ClusterForm, defaultForm, toManifest, toSpec, validate } from './form';

const Section = ({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) => (
  <Card>
    <CardHeader>
      <Flex direction="column" gap="1">
        <Text variant="title-x-small" as="h3">
          {title}
        </Text>
        {description && (
          <Text variant="body-small" color="secondary">
            {description}
          </Text>
        )}
      </Flex>
    </CardHeader>
    <CardBody>
      <Grid.Root columns={{ initial: '1', md: '2' }} gap="3">
        {children}
      </Grid.Root>
    </CardBody>
  </Card>
);

const opts = (values: Array<string | number>) => values.map(v => ({ id: String(v), label: String(v) }));

export const CreateClusterPage = () => {
  const api = useApi(cnpgApiRef);
  const navigate = useNavigate();
  const clusterLink = useRouteRef(clusterRouteRef);

  const { value: config } = useAsync(() => api.getConfig(), [api]);
  const { value: namespaces = [] } = useAsync(() => api.listNamespaces(), [api]);

  const [form, setForm] = useState<ClusterForm>(defaultForm());
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState<'validate' | 'create'>();
  const [result, setResult] = useState<{ error?: Error; validated?: boolean }>({});

  useEffect(() => {
    if (config?.defaultNamespace) {
      setForm(f => (f.namespace ? f : { ...f, namespace: config.defaultNamespace! }));
    }
  }, [config]);

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
                  label="Namespace"
                  isRequired
                  searchable
                  value={form.namespace || null}
                  onChange={k => set('namespace')(String(k ?? ''))}
                  options={opts(namespaces)}
                  description={err('namespace')}
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
                      description={err('backupSecretName') ?? 'Keys ACCESS_KEY_ID and ACCESS_SECRET_KEY, same namespace.'}
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
            <Flex direction="column" gap="3" style={{ position: 'sticky', top: 16 }}>
              <Card>
                <CardHeader>
                  <Text variant="title-x-small" as="h3">
                    Manifest
                  </Text>
                </CardHeader>
                <CardBody>
                  <pre
                    style={{
                      margin: 0,
                      fontSize: 12,
                      lineHeight: 1.5,
                      overflow: 'auto',
                      maxHeight: '55vh',
                    }}
                  >
                    {manifest}
                  </pre>
                </CardBody>
              </Card>
              {touched && Object.keys(errors).length > 0 && (
                <Alert status="warning" title="Fix the highlighted fields first" />
              )}
              {result.error && <ErrorAlert error={result.error} />}
              {result.validated && (
                <Alert
                  status="success"
                  title="Valid"
                  description="The API server accepted this manifest (dry run)."
                />
              )}
              <Flex gap="2" justify="end">
                <Button
                  variant="secondary"
                  loading={submitting === 'validate'}
                  isDisabled={Boolean(submitting)}
                  onPress={() => submit(true)}
                >
                  Validate
                </Button>
                <Button
                  variant="primary"
                  loading={submitting === 'create'}
                  isDisabled={Boolean(submitting)}
                  onPress={() => submit(false)}
                >
                  Create cluster
                </Button>
              </Flex>
            </Flex>
          </Grid.Item>
        </Grid.Root>
      </Container>
    </>
  );
};
