/**
 * Backend for the CNPG portal.
 *
 * - default export: the `cnpg` plugin (REST API at /api/cnpg)
 * - `catalogModuleCnpg`: mirrors Projects and PostgresClusters into the catalog
 * - `scaffolderModuleCnpg`: the `cnpg:postgrescluster:create` and
 *   `cnpg:project:create` actions
 *
 * @packageDocumentation
 */
export { cnpgPlugin as default } from './plugin';
export { catalogModuleCnpg } from './modules/catalog';
export { scaffolderModuleCnpg } from './modules/scaffolder';
