/**
 * Backend for the CNPG portal.
 *
 * - default export: the `cnpg` plugin (REST API at /api/cnpg)
 * - `catalogModuleCnpg`: mirrors PostgresClusters into the catalog
 * - `scaffolderModuleCnpg`: the `cnpg:postgrescluster:create` action
 *
 * @packageDocumentation
 */
export { cnpgPlugin as default } from './plugin';
export { catalogModuleCnpg } from './modules/catalog';
export { scaffolderModuleCnpg } from './modules/scaffolder';
