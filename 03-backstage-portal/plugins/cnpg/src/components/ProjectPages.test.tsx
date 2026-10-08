import { renderInTestApp, mockApis } from '@backstage/frontend-test-utils';
import { permissionApiRef } from '@backstage/plugin-permission-react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import type {
  PostgresClusterSummary,
  ProjectSummary,
} from '@internal/backstage-plugin-cnpg-common';
import { CnpgApi, cnpgApiRef } from '../api';
import { rootRouteRef } from '../routes';
import { CreateClusterPage } from './CreateClusterPage';
import { ProjectDetailPage } from './ProjectDetailPage';
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
  locations: ['ske'],
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

describe('ProjectDetailPage', () => {
  const render = (api: Partial<CnpgApi>) =>
    renderInTestApp(
      <Routes>
        <Route path="/p/:name" element={<ProjectDetailPage />} />
      </Routes>,
      { ...apis(api), initialRouteEntries: ['/p/demo'] } as any,
    );
  const getProject = jest.fn(async () => ({
    summary: project({}),
    resource: { apiVersion: 'v1', kind: 'Project', metadata: { name: 'demo' }, spec: {} },
  }));

  it("won't delete a project that still has clusters", async () => {
    const api: Partial<CnpgApi> = {
      getProject,
      listClusters: jest.fn(async () => [cluster('demo', 'orders-db')]),
      deleteProject: jest.fn(),
    };
    await render(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText(/still has 1 PostgreSQL cluster/)).toHaveTextContent('orders-db');
    expect(dialog.queryByLabelText(/to confirm/)).not.toBeInTheDocument();
    expect(dialog.getByRole('button', { name: 'Delete' })).toBeDisabled();
  });

  it('deletes an empty project once its name is typed', async () => {
    const api: Partial<CnpgApi> = {
      getProject,
      listClusters: jest.fn(async () => []),
      deleteProject: jest.fn(async () => undefined),
    };
    await render(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText(/namespace in ske stays/)).toBeInTheDocument();
    const confirm = dialog.getByRole('button', { name: 'Delete' });
    expect(confirm).toBeDisabled();
    fireEvent.change(dialog.getByLabelText(/to confirm/), { target: { value: 'demo' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(api.deleteProject).toHaveBeenCalledWith('demo'));
  });
});
