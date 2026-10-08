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
import { LocationService, locationServiceRef } from './service/LocationService';
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
    patch: jest.fn(async () => ordersDb),
    patchProject: jest.fn(async () => demoProject),
    deleteProject: jest.fn(async () => undefined),
    logs: jest.fn(async (_ns: string, _name: string, o: any, _kubeConfigFor?: unknown) => ({
      pod: o.pod,
      location: o.location ?? 'ske',
      container: 'postgres',
      text: '{"level":"info","msg":"hi"}\n',
    })),
  };
}

const prodLocation = {
  name: 'prod-ams',
  spec: { environment: 'production', region: 'ams' },
  connection: { server: 'https://prod:6443', context: 'prod', auth: 'token', insecureSkipTlsVerify: false },
  providerConfig: true,
  health: { status: 'healthy', checkedAt: '2026-10-07T09:00:00Z', checks: [] },
};

function fakeLocations() {
  return {
    list: jest.fn(async () => [prodLocation]),
    get: jest.fn(async (name: string) => {
      if (name === 'prod-ams') return prodLocation;
      throw new NotFoundError(`Location ${name} not found`);
    }),
    test: jest.fn(async () => prodLocation.health),
    create: jest.fn(async (o: any) => ({ ...prodLocation, name: o.name })),
    update: jest.fn(async () => prodLocation),
    delete: jest.fn(async () => undefined),
    kubeConfig: jest.fn(async (name: string) => ({ location: name })),
  };
}

async function start(
  k8s: ReturnType<typeof fakeK8s>,
  allow = true,
  locations = fakeLocations(),
) {
  const { server } = await startTestBackend({
    features: [
      cnpgPlugin,
      createServiceFactory({
        service: cnpgKubernetesServiceRef,
        deps: {},
        factory: () => k8s as unknown as CnpgKubernetesService,
      }),
      createServiceFactory({
        service: locationServiceRef,
        deps: {},
        factory: () => locations as unknown as LocationService,
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

  it('reads a cluster in other locations with their kubeconfig', async () => {
    const k8s = fakeK8s();
    const locations = fakeLocations();
    k8s.details.mockImplementation(async (_ns: string, _name: string, kubeConfigFor: any) => ({
      summary: { name: 'orders-db', namespace: 'demo' },
      resource: ordersDb,
      pods: [],
      events: [],
      kc: await kubeConfigFor('prod-ams'),
    }));
    const server = await start(k8s, true, locations);
    const res = await request(server).get('/api/cnpg/clusters/demo/orders-db');
    expect(res.status).toBe(200);
    expect(res.body.kc).toEqual({ location: 'prod-ams' });
    expect(locations.kubeConfig).toHaveBeenCalledWith('prod-ams');
  });

  it('returns pod logs with defaults for the query', async () => {
    const k8s = fakeK8s();
    const server = await start(k8s);
    const res = await request(server).get('/api/cnpg/clusters/demo/orders-db/logs?pod=orders-db-1');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ pod: 'orders-db-1', container: 'postgres' });
    expect(k8s.logs).toHaveBeenCalledWith(
      'demo',
      'orders-db',
      { pod: 'orders-db-1', tailLines: 500, previous: false },
      expect.any(Function),
    );
  });

  it('passes the location of the pod to the logs', async () => {
    const k8s = fakeK8s();
    const server = await start(k8s);
    const res = await request(server).get(
      '/api/cnpg/clusters/demo/orders-db/logs?pod=orders-db-1&location=prod-ams',
    );
    expect(res.status).toBe(200);
    expect(res.body.location).toBe('prod-ams');
    expect(k8s.logs.mock.calls[0][2]).toMatchObject({ location: 'prod-ams' });
  });

  it('rejects invalid log queries', async () => {
    const k8s = fakeK8s();
    const server = await start(k8s);
    for (const query of [
      '',
      '?pod=Bad_Pod',
      '?pod=orders-db-1&tailLines=100000',
      '?pod=orders-db-1&location=Not_A_Location',
    ]) {
      const res = await request(server).get(`/api/cnpg/clusters/demo/orders-db/logs${query}`);
      expect(res.status).toBe(400);
    }
    expect(k8s.logs).not.toHaveBeenCalled();
  });

  it('denies logs without read permission', async () => {
    const server = await start(fakeK8s(), false);
    const res = await request(server).get('/api/cnpg/clusters/demo/orders-db/logs?pod=orders-db-1');
    expect(res.status).toBe(403);
  });

  describe('locations', () => {
    it('lists locations with the projects that use them', async () => {
      const k8s = fakeK8s();
      k8s.listProjects.mockResolvedValue([
        demoProject,
        { ...demoProject, metadata: { name: 'ledger' }, spec: { locations: { protected: 'prod-ams' } } },
      ]);
      const server = await start(k8s);
      const res = await request(server).get('/api/cnpg/locations');
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([
        expect.objectContaining({ name: 'prod-ams', projects: ['ledger'] }),
      ]);
    });

    it("won't delete a location a project uses", async () => {
      const k8s = fakeK8s();
      const locations = fakeLocations();
      k8s.listProjects.mockResolvedValue([
        { ...demoProject, metadata: { name: 'ledger' }, spec: { locations: { protected: 'prod-ams' } } },
      ]);
      const server = await start(k8s, true, locations);
      const res = await request(server).delete('/api/cnpg/locations/prod-ams');
      expect(res.status).toBe(409);
      expect(res.body.error.message).toContain('ledger');
      expect(locations.delete).not.toHaveBeenCalled();
    });

    it('tests a kubeconfig without storing it on dryRun', async () => {
      const locations = fakeLocations();
      const server = await start(fakeK8s(), true, locations);
      const res = await request(server)
        .post('/api/cnpg/locations')
        .send({ name: 'new-loc', kubeconfig: 'apiVersion: v1', dryRun: true });
      expect(res.status).toBe(200);
      expect(res.body.health.status).toBe('healthy');
      expect(locations.test).toHaveBeenCalledWith({
        name: 'new-loc',
        kubeconfig: 'apiVersion: v1',
        spec: {},
      });
      expect(locations.create).not.toHaveBeenCalled();
    });

    it('creates a location with its settings', async () => {
      const locations = fakeLocations();
      const server = await start(fakeK8s(), true, locations);
      const res = await request(server)
        .post('/api/cnpg/locations')
        .send({
          name: 'new-loc',
          kubeconfig: 'apiVersion: v1',
          context: 'prod',
          spec: { environment: 'test', provider: 'kind', schedulable: true },
        });
      expect(res.status).toBe(201);
      expect(locations.create).toHaveBeenCalledWith({
        name: 'new-loc',
        kubeconfig: 'apiVersion: v1',
        context: 'prod',
        spec: { environment: 'test', provider: 'kind', schedulable: true },
      });
    });

    it('rejects unknown settings and bad names', async () => {
      const locations = fakeLocations();
      const server = await start(fakeK8s(), true, locations);
      for (const body of [
        { name: 'Bad_Name', kubeconfig: 'x' },
        { name: 'ok', kubeconfig: 'x', spec: { environment: 'staging' } },
        { name: 'ok', kubeconfig: 'x', spec: { surprise: true } },
        { name: 'ok', kubeconfig: '' },
        { name: 'local', kubeconfig: 'x' },
      ]) {
        const res = await request(server).post('/api/cnpg/locations').send(body);
        expect(res.status).toBe(400);
      }
      expect(locations.create).not.toHaveBeenCalled();
    });

    it('refreshes health on check and maps a missing location to 404', async () => {
      const locations = fakeLocations();
      const server = await start(fakeK8s(), true, locations);
      expect((await request(server).post('/api/cnpg/locations/prod-ams/check')).status).toBe(200);
      expect(locations.get).toHaveBeenCalledWith('prod-ams', { refresh: true });
      expect((await request(server).get('/api/cnpg/locations/nope')).status).toBe(404);
    });

    it('updates and deletes', async () => {
      const locations = fakeLocations();
      const server = await start(fakeK8s(), true, locations);
      const put = await request(server)
        .put('/api/cnpg/locations/prod-ams')
        .send({ spec: { displayName: 'Prod AMS' } });
      expect(put.status).toBe(200);
      expect(locations.update).toHaveBeenCalledWith('prod-ams', { spec: { displayName: 'Prod AMS' } });
      expect((await request(server).delete('/api/cnpg/locations/prod-ams')).status).toBe(200);
    });

    it('needs permission', async () => {
      const locations = fakeLocations();
      const server = await start(fakeK8s(), false, locations);
      expect((await request(server).get('/api/cnpg/locations')).status).toBe(403);
      const res = await request(server)
        .post('/api/cnpg/locations')
        .send({ name: 'x', kubeconfig: 'y' });
      expect(res.status).toBe(403);
      expect(locations.create).not.toHaveBeenCalled();
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

  it("won't delete a project that still has clusters", async () => {
    const k8s = fakeK8s();
    const server = await start(k8s);
    const res = await request(server).delete('/api/cnpg/projects/demo');
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('orders-db');
    expect(k8s.list).toHaveBeenCalledWith('demo');
    expect(k8s.deleteProject).not.toHaveBeenCalled();
  });

  it('deletes an empty project', async () => {
    const k8s = fakeK8s();
    k8s.list.mockResolvedValue([]);
    const server = await start(k8s);
    const res = await request(server).delete('/api/cnpg/projects/demo');
    expect(res.status).toBe(200);
    expect(k8s.deleteProject).toHaveBeenCalledWith('demo');
  });

  it('denies deleting a project without permission, and 404s a missing one', async () => {
    const k8s = fakeK8s();
    k8s.list.mockResolvedValue([]);
    expect((await request(await start(k8s, false)).delete('/api/cnpg/projects/demo')).status).toBe(403);
    expect((await request(await start(k8s)).delete('/api/cnpg/projects/nope')).status).toBe(404);
    expect(k8s.deleteProject).not.toHaveBeenCalled();
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

  it('patches only the changed fields of a cluster', async () => {
    const k8s = fakeK8s();
    const server = await start(k8s);
    const res = await request(server)
      .patch('/api/cnpg/clusters/demo/orders-db')
      .send({ spec: { instances: 5, storage: { size: '50Gi' }, pooler: null }, dryRun: true });
    expect(res.status).toBe(200);
    expect(k8s.patch).toHaveBeenCalledWith({
      namespace: 'demo',
      name: 'orders-db',
      spec: { instances: 5, storage: { size: '50Gi' }, pooler: null },
      labels: undefined,
      dryRun: true,
    });
  });

  it('changes the owner label of a cluster', async () => {
    const k8s = fakeK8s();
    const server = await start(k8s);
    await request(server)
      .patch('/api/cnpg/clusters/demo/orders-db')
      .send({ spec: {}, owner: 'team-b' });
    expect(k8s.patch).toHaveBeenCalledWith(
      expect.objectContaining({ labels: { 'backstage.io/owner': 'team-b' } }),
    );
  });

  it('keeps the project owner label in step with spec.owner', async () => {
    const k8s = fakeK8s();
    const server = await start(k8s);
    const res = await request(server)
      .patch('/api/cnpg/projects/demo')
      .send({ spec: { owner: '', quota: null } });
    expect(res.status).toBe(200);
    expect(k8s.patchProject).toHaveBeenCalledWith({
      name: 'demo',
      spec: { owner: null, quota: null },
      labels: { 'backstage.io/owner': null },
      dryRun: undefined,
    });
    const bad = await request(server)
      .patch('/api/cnpg/projects/demo')
      .send({ spec: { owner: 'not a group!' } });
    expect(bad.status).toBe(400);
  });

  describe('disaster recovery', () => {
    const geoDb: PostgresCluster = {
      ...ordersDb,
      spec: { ...ordersDb.spec, geoReplication: { enabled: true, primarySite: 'protected', promotion: 'Switchover' } },
      status: { ...ordersDb.status, primarySite: 'protected' },
    };

    it('switches over by patching only primarySite and promotion', async () => {
      const k8s = fakeK8s();
      k8s.get.mockResolvedValue(geoDb);
      const server = await start(k8s);
      const res = await request(server)
        .post('/api/cnpg/clusters/demo/orders-db/promote')
        .send({ site: 'recovery', mode: 'Switchover' });
      expect(res.status).toBe(200);
      expect(k8s.patch).toHaveBeenCalledWith({
        namespace: 'demo',
        name: 'orders-db',
        spec: { geoReplication: { primarySite: 'recovery', promotion: 'Switchover' } },
        dryRun: undefined,
      });
    });

    it('refuses moves that make no sense now with 409', async () => {
      const k8s = fakeK8s();
      const server = await start(k8s);
      // ordersDb has no replica cluster.
      const res = await request(server)
        .post('/api/cnpg/clusters/demo/orders-db/promote')
        .send({ site: 'recovery', mode: 'Failover' });
      expect(res.status).toBe(409);
      const bad = await request(server)
        .post('/api/cnpg/clusters/demo/orders-db/promote')
        .send({ site: 'elsewhere', mode: 'Switchover' });
      expect(bad.status).toBe(400);
      expect(k8s.patch).not.toHaveBeenCalled();
    });

    it('keeps edits from moving the primary', async () => {
      const k8s = fakeK8s();
      k8s.get.mockResolvedValue(geoDb);
      const server = await start(k8s);
      const moved = await request(server)
        .patch('/api/cnpg/clusters/demo/orders-db')
        .send({ spec: { geoReplication: { primarySite: 'recovery' } } });
      expect(moved.status).toBe(400);
      const drained = await request(server)
        .patch('/api/cnpg/clusters/demo/orders-db')
        .send({ spec: { geoReplication: { enabled: false, primarySite: 'protected' } } });
      expect(drained.status).toBe(200);
      expect(k8s.patch).toHaveBeenCalledTimes(1);
    });

    it('needs the switchover or failover permission', async () => {
      const k8s = fakeK8s();
      k8s.get.mockResolvedValue(geoDb);
      const server = await start(k8s, false);
      const res = await request(server)
        .post('/api/cnpg/clusters/demo/orders-db/promote')
        .send({ site: 'recovery', mode: 'Failover' });
      expect(res.status).toBe(403);
      expect(k8s.patch).not.toHaveBeenCalled();
    });
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
    const patched = await request(server).patch('/api/cnpg/projects/demo').send({ spec: {} });
    expect(patched.status).toBe(403);
    expect(k8s.patchProject).not.toHaveBeenCalled();
  });
});
