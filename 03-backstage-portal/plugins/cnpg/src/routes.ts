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

/** /cnpg/:namespace/:name/edit -- change a running cluster. */
export const editClusterRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/:namespace/:name/edit',
});

/** /cnpg/:namespace/:name/monitoring -- one cluster's Grafana dashboard. */
export const clusterMonitoringRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/:namespace/:name/monitoring',
});

/** /cnpg/:namespace/:name/logs -- stdout of the cluster's pods. */
export const clusterLogsRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/:namespace/:name/logs',
});

/** /cnpg/locations -- the Kubernetes clusters the platform can use. */
export const locationsRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/locations',
});

/** /cnpg/locations/create -- add a location from a kubeconfig. */
export const createLocationRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/locations/create',
});

/** /cnpg/locations/:name -- one location and its health. */
export const locationRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/locations/:name',
});

/** /cnpg/locations/:name/edit -- change a location's settings or kubeconfig. */
export const editLocationRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/locations/:name/edit',
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

/** /cnpg/projects/:name/edit -- change a project's settings. */
export const editProjectRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/projects/:name/edit',
});
