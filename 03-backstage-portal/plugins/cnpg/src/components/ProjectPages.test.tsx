import { renderInTestApp, mockApis } from '@backstage/frontend-test-utils';
import { permissionApiRef } from '@backstage/plugin-permission-react';
import { screen, within } from '@testing-library/react';
import type {
  PostgresClusterSummary,
  ProjectSummary,
} from '@internal/backstage-plugin-cnpg-common';
import { CnpgApi, cnpgApiRef } from '../api';
import { rootRouteRef } from '../routes';
import { CreateClusterPage } from './CreateClusterPage';
import { ProjectListPage } from './ProjectListPage';

const project = (over: Partial<ProjectSummary>): ProjectSummary => ({
  name: 'demo',
  owner: 'team-demo',
  ready: true,
  synced: true,
  deleting: false,
  deletionProtection: true,
  prometheus: true,
  grafana: true,
  grafanaUrl: 'http://grafana-demo.example.com',
  ...over,
});

const cluster = (namespace: string, name: string) =>
  ({ name, namespace, instances: 1, readyInstances: 1, ready: true }) as PostgresClusterSummary;

const apis = (api: Partial<CnpgApi>) => ({
  apis: [
    [cnpgApiRef, api],
    [permissionApiRef, mockApis.permission()],
  ] as const,
  mountedRoutes: { '/cnpg': rootRouteRef },
});

describe('ProjectListPage', () => {
  it('lists projects with health, cluster count and Grafana', async () => {
    const api: Partial<CnpgApi> = {
      listProjects: jest.fn(async () => [
        project({}),
        project({ name: 'payments', ready: false, grafanaUrl: undefined, owner: undefined }),
      ]),
      listClusters: jest.fn(async () => [cluster('demo', 'a'), cluster('demo', 'b'), cluster('other', 'c')]),
    };
    await renderInTestApp(<ProjectListPage />, apis(api) as any);

    expect(await screen.findByText('demo')).toBeInTheDocument();
    const table = within(screen.getByRole('grid'));
    expect(table.getByText('Healthy')).toBeInTheDocument();
    expect(table.getByText('Provisioning')).toBeInTheDocument();
    expect(table.getByText('2')).toBeInTheDocument();
    expect(table.getByText('Open')).toHaveAttribute('href', 'http://grafana-demo.example.com');
    expect(table.getByText('no ingress')).toBeInTheDocument();
    expect(screen.getByText('Create project')).toBeInTheDocument();
  });
});

describe('CreateClusterPage', () => {
  const base: Partial<CnpgApi> = {
    getConfig: jest.fn(async () => ({ storageClasses: [] })),
  };

  it('offers projects instead of free-text namespaces', async () => {
    const api: Partial<CnpgApi> = {
      ...base,
      listProjects: jest.fn(async () => [project({})]),
    };
    await renderInTestApp(<CreateClusterPage />, apis(api) as any);
    expect(await screen.findByText('Project')).toBeInTheDocument();
    expect(screen.queryByText('No projects yet')).not.toBeInTheDocument();
  });

  it('points to project creation when there are no projects', async () => {
    const api: Partial<CnpgApi> = {
      ...base,
      listProjects: jest.fn(async () => []),
    };
    await renderInTestApp(<CreateClusterPage />, apis(api) as any);
    expect(await screen.findByText('No projects yet')).toBeInTheDocument();
    expect(screen.getByText('Create project')).toBeInTheDocument();
  });
});
