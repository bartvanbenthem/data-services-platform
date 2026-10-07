import {
  Alert,
  Card,
  CardBody,
  CardHeader,
  CellText,
  type ColumnConfig,
  Flex,
  Grid,
  Skeleton,
  Table,
  Text,
  useTable,
} from '@backstage/ui';
import type {
  ClusterEvent,
  Condition,
  InstancePod,
  PostgresClusterDetails,
} from '@internal/backstage-plugin-cnpg-common';
import { ReactNode } from 'react';
import { age, Fields, health, Mono } from './common';

const StaticTable = <T extends { id: string }>({
  rows,
  columns,
  empty,
}: {
  rows: T[];
  columns: ColumnConfig<T>[];
  empty: string;
}) => {
  const { tableProps } = useTable({
    mode: 'complete',
    data: rows,
    paginationOptions: { pageSize: Math.max(rows.length, 1) },
  });
  return (
    <Table
      columnConfig={columns}
      {...tableProps}
      pagination={{ type: 'none' }}
      emptyState={<Text color="secondary">{empty}</Text>}
    />
  );
};

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <Card>
    <CardHeader>
      <Text variant="title-x-small" as="h3">
        {title}
      </Text>
    </CardHeader>
    <CardBody>{children}</CardBody>
  </Card>
);

const onOff = (v: unknown) => (v ? 'enabled' : 'disabled');

/**
 * Everything about one PostgresCluster: health, connection details,
 * configuration, instance pods, conditions and recent events. Shared by the
 * portal detail page and the catalog entity tab.
 */
export const ClusterDetails = ({ details }: { details: PostgresClusterDetails }) => {
  const { summary, resource, pods, events, cnpgStatus } = details;
  const spec = resource.spec;
  const status = resource.status ?? {};
  const ns = summary.namespace;
  const h = health(summary);

  const podRows = pods.map(p => ({ ...p, id: p.name }));
  const conditionRows = (status.conditions ?? []).map(c => ({ ...c, id: c.type }));
  const eventRows = events.map((e, i) => ({ ...e, id: `${i}` }));

  return (
    <Flex direction="column" gap="4">
      {h !== 'healthy' && (
        <Alert
          status={h === 'degraded' ? 'warning' : 'info'}
          title={h === 'deleting' ? 'Deleting' : summary.phase}
          description={summary.message}
        />
      )}

      <Grid.Root columns={{ initial: '1', md: '2' }} gap="4">
        <Section title="Overview">
          <Fields
            rows={[
              ['Phase', summary.phase],
              ['Instances ready', `${summary.readyInstances} / ${summary.instances}`],
              ['Primary', summary.currentPrimary ?? '-'],
              ['PostgreSQL', status.image ? <Mono>{status.image.split('@')[0]}</Mono> : `${spec.postgresVersion ?? '-'}`],
              ['Timeline', cnpgStatus?.timelineID ? String(cnpgStatus.timelineID) : '-'],
              ['Owner', summary.owner ?? '-'],
              ['Created', summary.createdAt ? `${new Date(summary.createdAt).toLocaleString()} (${age(summary.createdAt)} ago)` : '-'],
            ]}
          />
        </Section>

        <Section title="Connect">
          <Fields
            rows={[
              ['Read-write', <Mono>{status.endpoints?.readWrite}:5432</Mono>],
              ['Read-only', <Mono>{status.endpoints?.readOnly}:5432</Mono>],
              ...(status.endpoints?.pooler
                ? [['Pooler (rw)', <Mono>{status.endpoints.pooler}:5432</Mono>] as [string, ReactNode]]
                : []),
              ...(status.endpoints?.poolerReadOnly
                ? [['Pooler (ro)', <Mono>{status.endpoints.poolerReadOnly}:5432</Mono>] as [string, ReactNode]]
                : []),
              ['Database', `${spec.database?.name ?? 'app'} (owner ${spec.database?.owner ?? 'app'})`],
              ['Credentials', <Mono>Secret {ns}/{status.secrets?.app}</Mono>],
              [
                'Connection URI',
                <Mono>
                  kubectl -n {ns} get secret {status.secrets?.app} -o jsonpath='{'{'}.data.uri{'}'}' | base64 -d
                </Mono>,
              ],
            ]}
          />
        </Section>

        <Section title="Storage & resources">
          <Fields
            rows={[
              ['Data volume', `${spec.storage?.size ?? '-'}${spec.storage?.storageClass ? ` (${spec.storage.storageClass})` : ''}`],
              ['WAL volume', spec.walStorage ? `${spec.walStorage.size}` : 'shared with data'],
              ['CPU request', spec.resources?.requests?.cpu ?? '-'],
              ['Memory', `${spec.resources?.requests?.memory ?? '-'} request / ${spec.resources?.limits?.memory ?? '-'} limit`],
              ['Anti-affinity', spec.highAvailability?.podAntiAffinityType ?? 'preferred'],
              ['Sync replicas', String(spec.highAvailability?.synchronousReplicas ?? 0)],
            ]}
          />
        </Section>

        <Section title="Pooling, backups & monitoring">
          <Fields
            rows={[
              ['PgBouncer', spec.pooler?.enabled ? `${spec.pooler.instances ?? 2} × ${spec.pooler.poolMode ?? 'transaction'} mode` : 'disabled'],
              ['Backups', spec.backup?.enabled ? <Mono>{spec.backup.destinationPath}</Mono> : 'disabled'],
              ...(spec.backup?.enabled
                ? ([
                    ['Schedule', <Mono>{spec.backup.schedule}</Mono>],
                    ['Retention', spec.backup.retentionPolicy ?? '30d'],
                    ['Last backup', status.backup?.lastSuccessfulBackup || 'none yet'],
                    ['Recoverable from', status.backup?.firstRecoverabilityPoint || '-'],
                  ] as Array<[string, ReactNode]>)
                : []),
              ['Metrics (PodMonitor)', onOff(spec.monitoring?.enabled ?? true)],
              ['Alerts (PrometheusRule)', onOff(spec.monitoring?.prometheusRule?.enabled ?? true)],
              ['Grafana dashboard', status.monitoring?.dashboardUid ? <Mono>{status.monitoring.dashboardUid}</Mono> : 'disabled'],
            ]}
          />
        </Section>
      </Grid.Root>

      <Section title="Instances">
        <StaticTable<InstancePod & { id: string }>
          rows={podRows}
          empty="No pods yet."
          columns={[
            { id: 'name', label: 'Pod', isRowHeader: true, cell: p => <CellText title={p.name} /> },
            { id: 'role', label: 'Role', cell: p => <CellText title={p.role} /> },
            { id: 'phase', label: 'Phase', cell: p => <CellText title={p.phase} /> },
            { id: 'ready', label: 'Ready', cell: p => <CellText title={p.ready ? 'yes' : 'no'} /> },
            { id: 'node', label: 'Node', cell: p => <CellText title={p.node ?? '-'} /> },
            { id: 'restarts', label: 'Restarts', cell: p => <CellText title={String(p.restarts)} /> },
            { id: 'age', label: 'Age', cell: p => <CellText title={age(p.createdAt)} /> },
          ]}
        />
      </Section>

      <Section title="Conditions">
        <StaticTable<Condition & { id: string }>
          rows={conditionRows}
          empty="No conditions reported yet."
          columns={[
            { id: 'type', label: 'Type', isRowHeader: true, cell: c => <CellText title={c.type} /> },
            { id: 'status', label: 'Status', cell: c => <CellText title={c.status} /> },
            { id: 'reason', label: 'Reason', cell: c => <CellText title={c.reason ?? ''} /> },
            { id: 'message', label: 'Message', cell: c => <CellText title={c.message ?? ''} /> },
          ]}
        />
      </Section>

      <Section title="Recent events">
        <StaticTable<ClusterEvent & { id: string }>
          rows={eventRows}
          empty="No recent events."
          columns={[
            { id: 'type', label: 'Type', cell: e => <CellText title={e.type} /> },
            { id: 'reason', label: 'Reason', isRowHeader: true, cell: e => <CellText title={e.reason} /> },
            { id: 'object', label: 'Object', cell: e => <CellText title={e.object} /> },
            { id: 'message', label: 'Message', cell: e => <CellText title={e.message} /> },
            { id: 'last', label: 'Last seen', cell: e => <CellText title={`${age(e.lastSeen)} ago${e.count > 1 ? ` (×${e.count})` : ''}`} /> },
          ]}
        />
      </Section>
    </Flex>
  );
};

export const ClusterDetailsSkeleton = () => (
  <Flex direction="column" gap="4">
    <Skeleton height={120} />
    <Skeleton height={240} />
  </Flex>
);

