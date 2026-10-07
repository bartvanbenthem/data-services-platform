import { createRouteRef, createSubRouteRef } from '@backstage/frontend-plugin-api';

/** /cnpg -- the cluster list. */
export const rootRouteRef = createRouteRef();

/** /cnpg/create -- the create form. */
export const createClusterRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/create',
});

/** /cnpg/:namespace/:name -- one cluster. */
export const clusterRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/:namespace/:name',
});
