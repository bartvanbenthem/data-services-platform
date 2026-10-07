import { createServiceFactory } from '@backstage/backend-plugin-api';
import { mockServices, startTestBackend } from '@backstage/backend-test-utils';
import { NotFoundError } from '@backstage/errors';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import request from 'supertest';
import { cnpgPlugin } from './plugin';
import {
  CnpgKubernetesService,
  cnpgKubernetesServiceRef,
} from './service/CnpgKubernetesService';
import { PostgresCluster } from '@internal/backstage-plugin-cnpg-common';

const ordersDb: PostgresCluster = {
  apiVersion: 'cnpg.cncp.nl/v1alpha1',
  kind: 'PostgresCluster',
  metadata: {
    name: 'orders-db',
    namespace: 'demo',
    creationTimestamp: '2026-10-07T08:58:00Z',
    labels: { 'backstage.io/owner': 'team-orders' },
  },
  spec: { postgresVersion: 17, instances: 3, pooler: { enabled: true } },
  status: {
    phase: 'Cluster in healthy state',
    readyInstances: 3,
    currentPrimary: 'orders-db-1',
    conditions: [
      { type: 'Ready', status: 'True' },
      { type: 'Synced', status: 'True' },
    ],
  },
};

function fakeK8s() {
  return {
    list: jest.fn(async () => [ordersDb]),
    get: jest.fn(async (ns: string, name: string) => {
      if (ns === 'demo' && name === 'orders-db') return ordersDb;
      throw new NotFoundError(`PostgresCluster ${ns}/${name} not found`);
    }),
    details: jest.fn(),
    apply: jest.fn(async (o: any) => ({ ...ordersDb, metadata: { name: o.name, namespace: o.namespace } })),
    delete: jest.fn(async () => undefined),
    namespaces: jest.fn(async () => ['demo', 'payments']),
  };
}

async function start(k8s: ReturnType<typeof fakeK8s>, allow = true) {
  const { server } = await startTestBackend({
    features: [
      cnpgPlugin,
      createServiceFactory({
        service: cnpgKubernetesServiceRef,
        deps: {},
        factory: () => k8s as unknown as CnpgKubernetesService,
      }),
      mockServices.permissions.factory({
        result: allow ? AuthorizeResult.ALLOW : AuthorizeResult.DENY,
      }),
    ],
  });
  return server;
}

describe('cnpg backend', () => {
  it('lists clusters as summaries', async () => {
    const server = await start(fakeK8s());
    const res = await request(server).get('/api/cnpg/clusters');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      expect.objectContaining({
        name: 'orders-db',
        namespace: 'demo',
        instances: 3,
        readyInstances: 3,
        ready: true,
        synced: true,
        pooler: true,
        backup: false,
        owner: 'team-orders',
      }),
    ]);
  });

  it('creates a cluster with server-side apply and the owner label', async () => {
    const k8s = fakeK8s();
    const server = await start(k8s);
    const res = await request(server)
      .post('/api/cnpg/clusters')
      .send({ name: 'new-db', namespace: 'demo', owner: 'team-a', spec: { instances: 3 } });
    expect(res.status).toBe(201);
    expect(k8s.apply).toHaveBeenCalledWith({
      name: 'new-db',
      namespace: 'demo',
      spec: { instances: 3 },
      labels: { 'backstage.io/owner': 'team-a' },
      createOnly: true,
    });
  });

  it('rejects invalid cluster names before touching Kubernetes', async () => {
    const k8s = fakeK8s();
    const server = await start(k8s);
    const res = await request(server)
      .post('/api/cnpg/clusters')
      .send({ name: 'Bad_Name', namespace: 'demo', spec: {} });
    expect(res.status).toBe(400);
    expect(k8s.apply).not.toHaveBeenCalled();
  });

  it('maps a missing cluster to 404', async () => {
    const server = await start(fakeK8s());
    const res = await request(server).put('/api/cnpg/clusters/demo/nope').send({ spec: {} });
    expect(res.status).toBe(404);
  });

  it('deletes a cluster', async () => {
    const k8s = fakeK8s();
    const server = await start(k8s);
    const res = await request(server).delete('/api/cnpg/clusters/demo/orders-db');
    expect(res.status).toBe(202);
    expect(k8s.delete).toHaveBeenCalledWith('demo', 'orders-db');
  });

  it('enforces permissions', async () => {
    const k8s = fakeK8s();
    const server = await start(k8s, false);
    const res = await request(server).delete('/api/cnpg/clusters/demo/orders-db');
    expect(res.status).toBe(403);
    expect(k8s.delete).not.toHaveBeenCalled();
  });
});
