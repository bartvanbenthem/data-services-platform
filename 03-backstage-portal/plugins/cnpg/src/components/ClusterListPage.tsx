import { useApi, useRouteRef } from '@backstage/frontend-plugin-api';
import { usePermission } from '@backstage/plugin-permission-react';
import {
  ButtonLink,
  CellText,
  Cell,
  type ColumnConfig,
  Container,
  Flex,
  Header,
  SearchField,
  Select,
  Table,
  Text,
  useTable,
} from '@backstage/ui';
import {
  cnpgClusterCreatePermission,
  type PostgresClusterSummary,
} from '@internal/backstage-plugin-cnpg-common';
import { useMemo, useState } from 'react';
import useAsyncRetry from 'react-use/esm/useAsyncRetry';
import useInterval from 'react-use/esm/useInterval';
import { cnpgApiRef } from '../api';
import { clusterRouteRef, createClusterRouteRef } from '../routes';
import { age, ErrorAlert, HealthBadge } from './common';

type Row = PostgresClusterSummary & { id: string };

const ALL = '__all__';

export const ClusterListPage = () => {
  const api = useApi(cnpgApiRef);
  const clusterLink = useRouteRef(clusterRouteRef);
  const createLink = useRouteRef(createClusterRouteRef);
  const { allowed: canCreate } = usePermission({ permission: cnpgClusterCreatePermission });
  const [namespace, setNamespace] = useState<string>(ALL);
  const [search, setSearch] = useState('');

  const { value, loading, error, retry } = useAsyncRetry(() => api.listClusters(), [api]);
  // PostgresCluster status changes over minutes; poll instead of a manual refresh button.
  useInterval(retry, 15_000);

  const namespaces = useMemo(
    () => Array.from(new Set((value ?? []).map(c => c.namespace))).sort(),
    [value],
  );

  const rows: Row[] = useMemo(
    () =>
      (value ?? [])
        .filter(c => namespace === ALL || c.namespace === namespace)
        .filter(c => !search || `${c.namespace}/${c.name}`.includes(search.toLowerCase()))
        .map(c => ({ ...c, id: `${c.namespace}/${c.name}` })),
    [value, namespace, search],
  );

  const columns: ColumnConfig<Row>[] = [
    {
      id: 'name',
      label: 'Name',
      isRowHeader: true,
      cell: c => (
        <CellText
          title={c.name}
          description={c.owner ? `owner: ${c.owner}` : undefined}
          href={clusterLink?.({ namespace: c.namespace, name: c.name })}
        />
      ),
    },
    { id: 'namespace', label: 'Namespace', cell: c => <CellText title={c.namespace} /> },
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
    { id: 'primary', label: 'Primary', cell: c => <CellText title={c.currentPrimary ?? '-'} /> },
    {
      id: 'features',
      label: 'Features',
      cell: c => (
        <CellText
          title={[c.pooler && 'pooler', c.backup && 'backups'].filter(Boolean).join(', ') || '-'}
        />
      ),
    },
    { id: 'age', label: 'Age', cell: c => <CellText title={age(c.createdAt)} /> },
  ];

  const { tableProps } = useTable({
    mode: 'complete',
    data: rows,
    paginationOptions: { pageSize: 20 },
  });

  return (
    <>
      <Header
        title="PostgreSQL clusters"
        description="CloudNativePG clusters provisioned through the cnpg.cncp.nl PostgresCluster API"
        customActions={
          canCreate && createLink ? (
            <ButtonLink href={createLink()} variant="primary">
              Create cluster
            </ButtonLink>
          ) : undefined
        }
      />
      <Container>
        <Flex direction="column" gap="4">
          {error && <ErrorAlert error={error} />}
          <Flex gap="3" align="end">
            <Select
              label="Namespace"
              value={namespace}
              onChange={key => setNamespace(String(key ?? ALL))}
              options={[
                { id: ALL, label: 'All namespaces' },
                ...namespaces.map(n => ({ id: n, label: n })),
              ]}
            />
            <SearchField
              label="Search"
              placeholder="namespace/name"
              value={search}
              onChange={setSearch}
            />
          </Flex>
          <Table
            columnConfig={columns}
            {...tableProps}
            loading={loading && !value}
            emptyState={
              <Text color="secondary">
                No PostgresClusters found{namespace !== ALL ? ` in ${namespace}` : ''}.
              </Text>
            }
          />
        </Flex>
      </Container>
    </>
  );
};
