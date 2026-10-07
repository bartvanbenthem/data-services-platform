import { createRouteRef, createSubRouteRef } from '@backstage/frontend-plugin-api';

/** /cnpg -- the cluster list. */
export const rootRouteRef = createRouteRef();

/** /cnpg/create -- the create form. */
export const createClusterRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/create',
});

/** /cnpg/dashboards -- the Grafana dashboards of every cluster. */
export const dashboardsRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/dashboards',
});

/** /cnpg/:namespace/:name -- one cluster. */
export const clusterRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/:namespace/:name',
});

/** /cnpg/:namespace/:name/monitoring -- one cluster's Grafana dashboard. */
export const clusterMonitoringRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/:namespace/:name/monitoring',
});

/** /cnpg/projects -- the project list. */
export const projectsRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/projects',
});

/** /cnpg/projects/create -- the create-project form. */
export const createProjectRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/projects/create',
});

/** /cnpg/projects/:name -- one project and its clusters. */
export const projectRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/projects/:name',
});
