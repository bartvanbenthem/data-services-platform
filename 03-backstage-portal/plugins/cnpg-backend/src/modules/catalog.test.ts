import { mockServices } from '@backstage/backend-test-utils';
import { PostgresClusterEntityProvider } from './catalog';

describe('PostgresClusterEntityProvider', () => {
  const cluster = {
    apiVersion: 'cnpg.cncp.nl/v1alpha1',
    kind: 'PostgresCluster',
    metadata: {
      name: 'payments-db',
      namespace: 'payments',
      labels: { 'backstage.io/owner': 'team-payments', 'backstage.io/system': 'payments' },
    },
    spec: { postgresVersion: 17, instances: 3 },
    status: { monitoring: { dashboardUid: 'cnpg-abc' } },
  };

  const make = (k8s: any = {}) =>
    new PostgresClusterEntityProvider(
      k8s,
      { run: jest.fn() } as any,
      mockServices.logger.mock(),
      {
        defaultOwner: 'group:default/guests',
        appBaseUrl: 'https://portal.example.com',
        grafanaUrl: 'https://grafana.example.com/',
      },
    );

  it('maps a PostgresCluster to a Resource entity', () => {
    const entity = make().toEntity(cluster);
    expect(entity).toMatchObject({
      kind: 'Resource',
      metadata: {
        name: 'payments--payments-db',
        title: 'payments-db (payments)',
        annotations: {
          'cnpg.cncp.nl/postgrescluster': 'payments/payments-db',
          'backstage.io/kubernetes-id': 'payments-db',
          'backstage.io/kubernetes-namespace': 'payments',
        },
        tags: ['postgresql', 'cnpg', 'pg17'],
      },
      spec: { type: 'postgres-cluster', owner: 'team-payments', system: 'payments' },
    });
    expect(entity.metadata.links).toContainEqual({
      url: 'https://portal.example.com/cnpg/payments/payments-db',
      title: 'CNPG portal',
    });
    expect(entity.metadata.links).toContainEqual({
      url: 'https://grafana.example.com/d/cnpg-abc',
      title: 'Grafana dashboard',
    });
  });

  it('falls back to the default owner', () => {
    const entity = make().toEntity({ ...cluster, metadata: { name: 'a', namespace: 'b' } });
    expect(entity.spec?.owner).toBe('group:default/guests');
  });

  it('replaces the full entity set on refresh', async () => {
    const provider = make({ list: jest.fn(async () => [cluster]) });
    const connection = { applyMutation: jest.fn(), refresh: jest.fn() };
    await provider.connect(connection);
    await provider.refresh();
    expect(connection.applyMutation).toHaveBeenCalledWith({
      type: 'full',
      entities: [expect.objectContaining({ locationKey: 'cnpg-postgresclusters' })],
    });
  });
});
