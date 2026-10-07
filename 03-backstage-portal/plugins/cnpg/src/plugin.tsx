import {
  ApiBlueprint,
  createFrontendPlugin,
  discoveryApiRef,
  fetchApiRef,
  PageBlueprint,
} from '@backstage/frontend-plugin-api';
import { EntityContentBlueprint } from '@backstage/plugin-catalog-react/alpha';
import { CNPG_ANNOTATION } from '@internal/backstage-plugin-cnpg-common';
import { cnpgApiRef, CnpgClient } from './api';
import { PostgresIcon } from './components/common';
import {
  clusterMonitoringRouteRef,
  clusterRouteRef,
  createClusterRouteRef,
  createProjectRouteRef,
  dashboardsRouteRef,
  projectRouteRef,
  projectsRouteRef,
  rootRouteRef,
} from './routes';

export const cnpgApi = ApiBlueprint.make({
  params: defineParams =>
    defineParams({
      api: cnpgApiRef,
      deps: { discoveryApi: discoveryApiRef, fetchApi: fetchApiRef },
      factory: deps => new CnpgClient(deps),
    }),
});

/** /cnpg: list, create and inspect PostgresClusters; shows up in the sidebar. */
export const cnpgPage = PageBlueprint.make({
  params: {
    path: '/cnpg',
    title: 'PostgreSQL',
    icon: <PostgresIcon />,
    routeRef: rootRouteRef,
    noHeader: true,
    loader: () => import('./components/Router').then(m => <m.Router />),
  },
});

/** "PostgreSQL" tab on the catalog Resource entities the cnpg backend creates. */
export const cnpgEntityContent = EntityContentBlueprint.make({
  name: 'postgres',
  params: {
    path: 'postgres',
    title: 'PostgreSQL',
    icon: <PostgresIcon />,
    filter: entity => Boolean(entity.metadata.annotations?.[CNPG_ANNOTATION]),
    loader: () =>
      import('./components/EntityPostgresContent').then(m => <m.EntityPostgresContent />),
  },
});

export const cnpgPlugin = createFrontendPlugin({
  pluginId: 'cnpg',
  info: { packageJson: () => import('../package.json') },
  extensions: [cnpgApi, cnpgPage, cnpgEntityContent],
  routes: {
    root: rootRouteRef,
    cluster: clusterRouteRef,
    create: createClusterRouteRef,
    dashboards: dashboardsRouteRef,
    clusterMonitoring: clusterMonitoringRouteRef,
    projects: projectsRouteRef,
    project: projectRouteRef,
    createProject: createProjectRouteRef,
  },
});
