import { createMockActionContext } from '@backstage/plugin-scaffolder-node-test-utils';
import { createPostgresClusterAction, prune } from './scaffolder';

describe('cnpg:postgrescluster:create', () => {
  it('prunes empty optional values', () => {
    expect(
      prune({
        instances: 3,
        pooler: { enabled: false },
        backup: { enabled: false, destinationPath: '', endpointURL: undefined, s3Credentials: { secretName: '' } },
        labels: [],
      }),
    ).toEqual({ instances: 3, pooler: { enabled: false }, backup: { enabled: false }, labels: [] });
  });

  it('applies the cluster with owner/system labels and outputs links', async () => {
    const k8s = { apply: jest.fn(async () => ({})) };
    const action = createPostgresClusterAction(k8s as any);
    const ctx = createMockActionContext({
      input: {
        name: 'orders-db',
        namespace: 'demo',
        owner: 'group:default/team-orders',
        system: 'system:default/orders',
        spec: { instances: 3, backup: { enabled: false, destinationPath: '' } },
      },
    });
    await action.handler(ctx);
    expect(k8s.apply).toHaveBeenCalledWith({
      name: 'orders-db',
      namespace: 'demo',
      spec: { instances: 3, backup: { enabled: false } },
      labels: { 'backstage.io/owner': 'team-orders', 'backstage.io/system': 'orders' },
      createOnly: true,
      dryRun: undefined,
    });
    expect(ctx.output).toHaveBeenCalledWith('portalPath', '/cnpg/demo/orders-db');
    expect(ctx.output).toHaveBeenCalledWith('entityRef', 'resource:default/demo--orders-db');
  });
});
