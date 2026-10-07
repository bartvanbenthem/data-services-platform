import { useApi, useRouteRef } from '@backstage/frontend-plugin-api';
import { usePermission } from '@backstage/plugin-permission-react';
import {
  Alert,
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  Cell,
  CellText,
  type ColumnConfig,
  Container,
  Flex,
  Grid,
  Header,
  Link,
  Skeleton,
  Table,
  Text,
  useTable,
} from '@backstage/ui';
import {
  cnpgClusterCreatePermission,
  cnpgProjectUpdatePermission,
  type PostgresClusterSummary,
  type ProjectSummary,
} from '@internal/backstage-plugin-cnpg-common';
import { ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import useAsyncRetry from 'react-use/esm/useAsyncRetry';
import useInterval from 'react-use/esm/useInterval';
import { cnpgApiRef } from '../api';
import { clusterRouteRef, createClusterRouteRef, editProjectRouteRef } from '../routes';
import { ErrorAlert, Fields, HealthBadge, Mono, ProjectHealthBadge } from './common';

const Panel = ({ title, children }: { title: string; children: ReactNode }) => (
  <Card>
    <CardHeader>
      <Text variant="title-x-small" as="h3">
        {title}
      </Text>
    </CardHeader>
    <CardBody>{children}</CardBody>
  </Card>
);

type Row = PostgresClusterSummary & { id: string };

const ClusterTable = ({ clusters }: { clusters: PostgresClusterSummary[] }) => {
  const clusterLink = useRouteRef(clusterRouteRef);
  const columns: ColumnConfig<Row>[] = [
    {
      id: 'name',
      label: 'Name',
      isRowHeader: true,
      cell: c => (
        <CellText title={c.name} href={clusterLink?.({ namespace: c.namespace, name: c.name })} />
      ),
    },
    {
      id: 'status',
      label: 'Status',
      cell: c => (
        <Cell>
          <HealthBadge cluster={c} />
        </Cell>
      ),
    },
    {
      id: 'version',
      label: 'PostgreSQL',
      cell: c => <CellText title={c.postgresVersion ? String(c.postgresVersion) : '-'} />,
    },
    {
      id: 'instances',
      label: 'Instances',
      cell: c => <CellText title={`${c.readyInstances}/${c.instances}`} />,
    },
  ];
  const { tableProps } = useTable({
    mode: 'complete',
    data: clusters.map(c => ({ ...c, id: c.name })),
    paginationOptions: { pageSize: Math.max(clusters.length, 1) },
  });
  return (
    <Table
      columnConfig={columns}
      {...tableProps}
      pagination={{ type: 'none' }}
      emptyState={<Text color="secondary">No PostgreSQL clusters in this project yet.</Text>}
    />
  );
};

/** Grafana for browsers if there's an ingress, else the in-cluster URL. */
function grafanaField(summary: ProjectSummary, internalUrl?: string): ReactNode {
  if (summary.grafanaUrl) {
    return (
      <Link href={summary.grafanaUrl} target="_blank" rel="noopener noreferrer">
        {summary.grafanaUrl}
      </Link>
    );
  }
  if (!summary.grafana) return 'disabled';
  return internalUrl ? <Mono>{internalUrl}</Mono> : 'provisioning';
}

function prometheusField(summary: ProjectSummary, url?: string): ReactNode {
  if (url) return <Mono>{url}</Mono>;
  return summary.prometheus ? 'provisioning' : 'disabled';
}

/** One project: its observability endpoints, settings and the clusters in it. */
export const ProjectDetailPage = () => {
  const { name = '' } = useParams();
  const api = useApi(cnpgApiRef);
  const createClusterLink = useRouteRef(createClusterRouteRef);
  const editLink = useRouteRef(editProjectRouteRef);
  const { allowed: canCreateCluster } = usePermission({ permission: cnpgClusterCreatePermission });
  const { allowed: canUpdate } = usePermission({ permission: cnpgProjectUpdatePermission });

  const { value, error, retry } = useAsyncRetry(async () => {
    const [project, clusters] = await Promise.all([
      api.getProject(name),
      api.listClusters(name),
    ]);
    return { ...project, clusters };
  }, [api, name]);
  useInterval(retry, 15_000);

  const summary = value?.summary;
  const spec = value?.resource.spec;
  const status = value?.resource.status;

  return (
    <>
      <Header
        title={name}
        tags={[{ label: 'project' }]}
        customActions={
          <Flex gap="3" align="center">
            {summary && <ProjectHealthBadge project={summary} />}
            {canUpdate && editLink && summary && !summary.deleting && (
              <ButtonLink href={editLink({ name })} variant="secondary">
                Edit
              </ButtonLink>
            )}
            {canCreateCluster && createClusterLink && (
              <ButtonLink
                href={`${createClusterLink()}?project=${encodeURIComponent(name)}`}
                variant="primary"
              >
                Create cluster here
              </ButtonLink>
            )}
          </Flex>
        }
      />
      <Container>
        {error && !value && <ErrorAlert error={error} />}
        {!error && !value && <Skeleton width="100%" height={240} />}
        {value && summary && (
          <Flex direction="column" gap="4">
            {!summary.ready && (
              <Alert
                status="info"
                title="Provisioning"
                description={summary.message ?? 'Waiting for Prometheus and Grafana.'}
              />
            )}
            <Grid.Root columns={{ initial: '1', md: '2' }} gap="4">
              <Panel title="Project">
                <Fields
                  rows={[
                    ['Owner', summary.owner ?? '-'],
                    ['Description', summary.description ?? '-'],
                    [
                      'Access',
                      spec?.access?.length
                        ? spec.access.map(a => `${a.group} (${a.role})`).join(', ')
                        : '-',
                    ],
                    [
                      'Quota',
                      spec?.quota
                        ? [
                            spec.quota.cpu && `cpu ${spec.quota.cpu}`,
                            spec.quota.memory && `memory ${spec.quota.memory}`,
                            spec.quota.storage && `storage ${spec.quota.storage}`,
                          ]
                            .filter(Boolean)
                            .join(', ')
                        : 'none',
                    ],
                    [
                      'Deletion protection',
                      summary.deletionProtection ? 'on' : 'off: deleting the project deletes its databases',
                    ],
                  ]}
                />
              </Panel>
              <Panel title="Observability">
                <Fields
                  rows={[
                    ['Grafana', grafanaField(summary, status?.grafana?.internalUrl)],
                    [
                      'Grafana admin',
                      status?.grafana?.adminSecret ? (
                        <Mono>{`${name}/${status.grafana.adminSecret}`}</Mono>
                      ) : (
                        '-'
                      ),
                    ],
                    ['Prometheus', prometheusField(summary, status?.prometheus?.url)],
                    ['Retention', spec?.observability?.prometheus?.retention ?? '-'],
                  ]}
                />
              </Panel>
            </Grid.Root>
            <Panel title="PostgreSQL clusters">
              <ClusterTable clusters={value.clusters} />
            </Panel>
          </Flex>
        )}
      </Container>
    </>
  );
};
