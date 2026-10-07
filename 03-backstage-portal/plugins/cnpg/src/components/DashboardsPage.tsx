import { useApi, useRouteRef } from '@backstage/frontend-plugin-api';
import {
  Card,
  CardBody,
  Container,
  Flex,
  Grid,
  Header,
  Link,
  Skeleton,
  Text,
} from '@backstage/ui';
import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import useAsync from 'react-use/esm/useAsync';
import useAsyncRetry from 'react-use/esm/useAsyncRetry';
import useInterval from 'react-use/esm/useInterval';
import { cnpgApiRef } from '../api';
import { clusterRouteRef } from '../routes';
import { ErrorAlert, HealthBadge } from './common';
import { GrafanaDashboard } from './GrafanaDashboard';

/**
 * Every PostgresCluster's CloudNativePG Grafana dashboard in one place: pick a
 * cluster on the left, the dashboard is embedded on the right. The selection
 * lives in ?cluster=<namespace>/<name> so it can be linked to.
 */
export const DashboardsPage = () => {
  const api = useApi(cnpgApiRef);
  const clusterLink = useRouteRef(clusterRouteRef);
  const [params, setParams] = useSearchParams();
  const { value: config } = useAsync(() => api.getConfig(), [api]);
  const { value, loading, error, retry } = useAsyncRetry(
    () => api.listClusters(),
    [api],
  );
  useInterval(retry, 30_000);

  const clusters = useMemo(
    () =>
      (value ?? [])
        .filter(c => c.dashboardUid)
        .sort((a, b) =>
          `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`),
        ),
    [value],
  );
  const selectedId = params.get('cluster');
  const selected =
    clusters.find(c => `${c.namespace}/${c.name}` === selectedId) ??
    clusters[0];

  return (
    <>
      <Header
        title="Dashboards"
        description="CloudNativePG Grafana dashboards, created per cluster by the PostgresCluster composition"
      />
      <Container>
        {error && <ErrorAlert error={error} />}
        {loading && !value && <Skeleton height={480} />}
        {value && clusters.length === 0 && (
          <Card>
            <CardBody>
              <Text color="secondary">
                No cluster has a Grafana dashboard yet. Dashboards are created
                when monitoring.grafanaDashboard.enabled is true, which is the
                default.
              </Text>
            </CardBody>
          </Card>
        )}
        {selected && (
          <Grid.Root columns={{ initial: '1', md: '12' }} gap="4">
            <Grid.Item colSpan={{ initial: '1', md: '3' }}>
              <Card>
                <CardBody>
                  <div
                    className="kpn-picker"
                    role="group"
                    aria-label="Clusters"
                  >
                    {clusters.map(c => {
                      const id = `${c.namespace}/${c.name}`;
                      return (
                        <button
                          key={id}
                          type="button"
                          aria-pressed={c === selected}
                          onClick={() =>
                            setParams({ cluster: id }, { replace: true })
                          }
                        >
                          <Flex direction="column" gap="1">
                            <span>{c.name}</span>
                            <HealthBadge cluster={c} />
                          </Flex>
                          <small>{c.namespace}</small>
                        </button>
                      );
                    })}
                  </div>
                </CardBody>
              </Card>
            </Grid.Item>
            <Grid.Item colSpan={{ initial: '1', md: '9' }}>
              <Flex direction="column" gap="2">
                <GrafanaDashboard
                  grafanaUrl={selected.grafanaUrl ?? config?.grafanaUrl}
                  namespace={selected.namespace}
                  name={selected.name}
                  uid={selected.dashboardUid}
                  height="calc(100vh - 200px)"
                />
                {clusterLink && (
                  <Link
                    variant="body-small"
                    href={clusterLink({
                      namespace: selected.namespace,
                      name: selected.name,
                    })}
                  >
                    Cluster details for {selected.namespace}/{selected.name}
                  </Link>
                )}
              </Flex>
            </Grid.Item>
          </Grid.Root>
        )}
      </Container>
    </>
  );
};
