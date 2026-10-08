import { createPermission } from '@backstage/plugin-permission-common';

/**
 * Permissions guarding the cnpg API. With the default allow-all policy every
 * signed-in user can do everything; write a permission policy that matches
 * on these names to restrict who may create or delete databases.
 */
export const cnpgClusterReadPermission = createPermission({
  name: 'cnpg.cluster.read',
  attributes: { action: 'read' },
});

export const cnpgClusterCreatePermission = createPermission({
  name: 'cnpg.cluster.create',
  attributes: { action: 'create' },
});

export const cnpgClusterUpdatePermission = createPermission({
  name: 'cnpg.cluster.update',
  attributes: { action: 'update' },
});

export const cnpgClusterDeletePermission = createPermission({
  name: 'cnpg.cluster.delete',
  attributes: { action: 'delete' },
});

/**
 * Create a cluster from another cluster's backups (also needs
 * cnpg.cluster.create). The new cluster holds a copy of that data, so this
 * is reading it.
 */
export const cnpgClusterRestorePermission = createPermission({
  name: 'cnpg.cluster.restore',
  attributes: { action: 'create' },
});

/**
 * Planned move of a geo-replicated cluster's primary to the other site: the
 * primary is demoted first, so no transaction is lost.
 */
export const cnpgClusterSwitchoverPermission = createPermission({
  name: 'cnpg.cluster.switchover',
  attributes: { action: 'update' },
});

/**
 * Promote the other site right away, for when the primary's site is down.
 * Transactions not archived yet are lost: reserve it for on-call or platform
 * admins.
 */
export const cnpgClusterFailoverPermission = createPermission({
  name: 'cnpg.cluster.failover',
  attributes: { action: 'update' },
});

/** List Projects (also what the create-cluster form needs to offer namespaces). */
export const cnpgProjectReadPermission = createPermission({
  name: 'cnpg.project.read',
  attributes: { action: 'read' },
});

/**
 * Create a Project: a namespace with its own Prometheus and Grafana. Usually
 * reserved for platform admins or team leads.
 */
export const cnpgProjectCreatePermission = createPermission({
  name: 'cnpg.project.create',
  attributes: { action: 'create' },
});

/** Change a Project's owner, access, quota and observability settings. */
export const cnpgProjectUpdatePermission = createPermission({
  name: 'cnpg.project.update',
  attributes: { action: 'update' },
});

/**
 * Delete a Project that no longer has PostgreSQL clusters: its namespace,
 * Prometheus and Grafana (and their metrics) on the control plane go with
 * it. The portal turns its deletionProtection off for the delete.
 */
export const cnpgProjectDeletePermission = createPermission({
  name: 'cnpg.project.delete',
  attributes: { action: 'delete' },
});

/** List and inspect locations (never their kubeconfig) and run their health checks. */
export const cnpgLocationReadPermission = createPermission({
  name: 'cnpg.location.read',
  attributes: { action: 'read' },
});

/**
 * Add a location: hand the platform a kubeconfig for another cluster. Meant
 * for platform admins only.
 */
export const cnpgLocationCreatePermission = createPermission({
  name: 'cnpg.location.create',
  attributes: { action: 'create' },
});

/** Change a location's settings or replace its kubeconfig. */
export const cnpgLocationUpdatePermission = createPermission({
  name: 'cnpg.location.update',
  attributes: { action: 'update' },
});

/** Remove a location (and its stored kubeconfig). Databases on it are not touched. */
export const cnpgLocationDeletePermission = createPermission({
  name: 'cnpg.location.delete',
  attributes: { action: 'delete' },
});

export const cnpgPermissions = [
  cnpgClusterReadPermission,
  cnpgClusterCreatePermission,
  cnpgClusterUpdatePermission,
  cnpgClusterDeletePermission,
  cnpgClusterRestorePermission,
  cnpgClusterSwitchoverPermission,
  cnpgClusterFailoverPermission,
  cnpgProjectReadPermission,
  cnpgProjectCreatePermission,
  cnpgProjectUpdatePermission,
  cnpgProjectDeletePermission,
  cnpgLocationReadPermission,
  cnpgLocationCreatePermission,
  cnpgLocationUpdatePermission,
  cnpgLocationDeletePermission,
];
