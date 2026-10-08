import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { cnpgPermissions } from '@internal/backstage-plugin-cnpg-common';
import { createRouter } from './router';
import { bucketServiceRef } from './service/BucketService';
import { cnpgKubernetesServiceRef } from './service/CnpgKubernetesService';
import { locationServiceRef } from './service/LocationService';

/**
 * REST API for the CNPG portal: list / inspect / create / update / delete
 * cnpg.cncp.nl PostgresClusters. Mounted at /api/cnpg.
 *
 * @public
 */
export const cnpgPlugin = createBackendPlugin({
  pluginId: 'cnpg',
  register(env) {
    env.registerInit({
      deps: {
        httpAuth: coreServices.httpAuth,
        httpRouter: coreServices.httpRouter,
        permissions: coreServices.permissions,
        permissionsRegistry: coreServices.permissionsRegistry,
        config: coreServices.rootConfig,
        k8s: cnpgKubernetesServiceRef,
        locations: locationServiceRef,
        buckets: bucketServiceRef,
      },
      async init({
        httpAuth,
        httpRouter,
        permissions,
        permissionsRegistry,
        config,
        k8s,
        locations,
        buckets,
      }) {
        permissionsRegistry.addPermissions(cnpgPermissions);
        httpRouter.use(await createRouter({ httpAuth, permissions, config, k8s, locations, buckets }));
        httpRouter.addAuthPolicy({ path: '/health', allow: 'unauthenticated' });
      },
    });
  },
});
