import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { cnpgPermissions } from '@internal/backstage-plugin-cnpg-common';
import { createRouter } from './router';
import { cnpgKubernetesServiceRef } from './service/CnpgKubernetesService';

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
      },
      async init({ httpAuth, httpRouter, permissions, permissionsRegistry, config, k8s }) {
        permissionsRegistry.addPermissions(cnpgPermissions);
        httpRouter.use(await createRouter({ httpAuth, permissions, config, k8s }));
        httpRouter.addAuthPolicy({ path: '/health', allow: 'unauthenticated' });
      },
    });
  },
});
