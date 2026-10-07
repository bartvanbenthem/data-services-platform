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
import { PostgresCluster, Project } from '@internal/backstage-plugin-cnpg-common';

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

const demoProject: Project = {
  apiVersion: 'platform.cncp.nl/v1alpha1',
  kind: 'Project',
  metadata: { name: 'demo', creationTimestamp: '2026-10-07T08:00:00Z' },
  spec: { owner: 'team-demo', deletionProtection: true },
  status: {
    namespace: 'demo',
    grafana: { url: 'http://grafana-demo.example.com' },
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
    listProjects: jest.fn(async () => [demoProject]),
    getProject: jest.fn(async (name: string) => {
      if (name === 'demo') return demoProject;
      throw new NotFoundError(`Project ${name} not found`);
    }),
    applyProject: jest.fn(async (o: any) => ({ ...demoProject, metadata: { name: o.name } })),
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
        project: 'demo',
        grafanaUrl: 'http://grafana-demo.example.com',
      }),
    ]);
  });

  it('leaves clusters outside a project without project info', async () => {
    const k8s = fakeK8s();
    k8s.listProjects.mockResolvedValue([]);
    const server = await start(k8s);
    const res = await request(server).get('/api/cnpg/clusters');
    expect(res.body.items[0].project).toBeUndefined();
    expect(res.body.items[0].grafanaUrl).toBeUndefined();
  });

  it('adds the project to cluster details', async () => {
    const k8s = fakeK8s();
    k8s.details.mockResolvedValue({
      summary: { name: 'orders-db', namespace: 'demo' },
      resource: ordersDb,
      pods: [],
      events: [],
    });
    const server = await start(k8s);
    const res = await request(server).get('/api/cnpg/clusters/demo/orders-db');
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({
      project: 'demo',
      grafanaUrl: 'http://grafana-demo.example.com',
    });
  });

  it('lists projects as summaries', async () => {
    const server = await start(fakeK8s());
    const res = await request(server).get('/api/cnpg/projects');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      expect.objectContaining({
        name: 'demo',
        owner: 'team-demo',
        ready: true,
        deletionProtection: true,
        prometheus: true,
        grafana: true,
        grafanaUrl: 'http://grafana-demo.example.com',
      }),
    ]);
  });

  it('creates a project with the owner in spec and label', async () => {
    const k8s = fakeK8s();
    const server = await start(k8s);
    const res = await request(server)
      .post('/api/cnpg/projects')
      .send({
        name: 'team-a',
        owner: 'team-a',
        description: 'A team',
        spec: { quota: { cpu: '4' } },
      });
    expect(res.status).toBe(201);
    expect(k8s.applyProject).toHaveBeenCalledWith({
      name: 'team-a',
      spec: { quota: { cpu: '4' }, owner: 'team-a', description: 'A team' },
      labels: { 'backstage.io/owner': 'team-a' },
      createOnly: true,
      dryRun: undefined,
    });
  });

  it('rejects project names the XRD would reject', async () => {
    const k8s = fakeK8s();
    const server = await start(k8s);
    for (const name of ['Bad_Name', 'a--b']) {
      const res = await request(server).post('/api/cnpg/projects').send({ name });
      expect(res.status).toBe(400);
    }
    expect(k8s.applyProject).not.toHaveBeenCalled();
  });

  it('maps a missing project to 404', async () => {
    const server = await start(fakeK8s());
    const res = await request(server).get('/api/cnpg/projects/nope');
    expect(res.status).toBe(404);
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
    const created = await request(server).post('/api/cnpg/projects').send({ name: 'team-a' });
    expect(created.status).toBe(403);
    expect(k8s.applyProject).not.toHaveBeenCalled();
  });
});
