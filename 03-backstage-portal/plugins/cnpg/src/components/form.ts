/**
 * Create/edit-form state and its mapping onto a PostgresCluster spec. Only
 * what the form exposes is sent; everything else falls back to the XRD
 * defaults, and the API server validates the result against the XRD.
 */

import type { PostgresCluster, Site } from '@internal/backstage-plugin-cnpg-common';

export interface ClusterForm {
  name: string;
  namespace: string;
  owner: string;
  /** A replica cluster in the project's recovery location. */
  geoReplication: boolean;
  /** Its instances; 0 means as many as the cluster's. */
  geoInstances: number;
  /** Where the primary runs; changing it on an existing cluster switches over. */
  primarySite: Site;
  promotion: 'Switchover' | 'Failover';
  postgresVersion: number;
  instances: number;
  storageSize: string;
  storageClass: string;
  walEnabled: boolean;
  walSize: string;
  cpu: string;
  memory: string;
  databaseName: string;
  databaseOwner: string;
  podAntiAffinityType: 'preferred' | 'required';
  zoneSpread: boolean;
  synchronousReplicas: number;
  synchronousDataDurability: 'preferred' | 'required';
  poolerEnabled: boolean;
  poolerInstances: number;
  poolMode: 'transaction' | 'session';
  poolerReadOnly: boolean;
  backupEnabled: boolean;
  /** Archive to the Project's COSI bucket instead of a destination of its own. */
  backupProjectBucket: boolean;
  backupDestinationPath: string;
  backupEndpointURL: string;
  backupSecretName: string;
  backupRetention: string;
  backupSchedule: string;
  monitoringEnabled: boolean;
  dashboardEnabled: boolean;
}

export const defaultForm = (namespace = ''): ClusterForm => ({
  name: '',
  namespace,
  owner: '',
  geoReplication: false,
  geoInstances: 0,
  primarySite: 'protected',
  promotion: 'Switchover',
  postgresVersion: 17,
  instances: 3,
  storageSize: '10Gi',
  storageClass: '',
  walEnabled: false,
  walSize: '5Gi',
  cpu: '500m',
  memory: '1Gi',
  databaseName: 'app',
  databaseOwner: 'app',
  podAntiAffinityType: 'preferred',
  zoneSpread: true,
  synchronousReplicas: 0,
  synchronousDataDurability: 'preferred',
  poolerEnabled: false,
  poolerInstances: 2,
  poolMode: 'transaction',
  poolerReadOnly: false,
  backupEnabled: false,
  backupProjectBucket: false,
  backupDestinationPath: '',
  backupEndpointURL: '',
  backupSecretName: '',
  backupRetention: '30d',
  backupSchedule: '0 0 2 * * *',
  monitoringEnabled: true,
  dashboardEnabled: true,
});

const NAME = /^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$/;
const QUANTITY = /^[0-9]+(Mi|Gi|Ti)$/;
const PG_IDENT = /^[a-z_][a-z0-9_]*$/;

/** Field-level errors shown inline; the API server remains the final validator. */
export function validate(f: ClusterForm): Partial<Record<keyof ClusterForm, string>> {
  const e: Partial<Record<keyof ClusterForm, string>> = {};
  if (!NAME.test(f.name)) e.name = 'Lowercase letters, digits and "-", starting with a letter, max 40 characters.';
  if (!f.namespace) e.namespace = 'Pick a project.';
  if (f.owner && !/^[A-Za-z0-9][-A-Za-z0-9_.]{0,62}$/.test(f.owner)) e.owner = 'A group name, e.g. team-payments.';
  if (!QUANTITY.test(f.storageSize)) e.storageSize = 'e.g. 20Gi';
  if (f.walEnabled && !QUANTITY.test(f.walSize)) e.walSize = 'e.g. 5Gi';
  if (!PG_IDENT.test(f.databaseName)) e.databaseName = 'A PostgreSQL identifier, e.g. orders.';
  if (!PG_IDENT.test(f.databaseOwner)) e.databaseOwner = 'A PostgreSQL identifier, e.g. orders.';
  if (f.synchronousReplicas >= f.instances) e.synchronousReplicas = 'Must be lower than the number of instances.';
  if (f.geoReplication && !f.backupEnabled) {
    e.geoReplication = 'The replica cluster is fed from the backup object store: enable backups.';
  }
  if (f.geoReplication && f.geoInstances > 0 && f.synchronousReplicas >= f.geoInstances) {
    e.geoInstances = 'Must be higher than the synchronous replicas.';
  }
  if (f.primarySite === 'recovery' && !f.geoReplication) {
    e.primarySite = 'The primary can only be in the recovery site while geo replication is on.';
  }
  if (f.backupEnabled && !f.backupProjectBucket) {
    if (!/^s3:\/\/.+/.test(f.backupDestinationPath)) e.backupDestinationPath = 'e.g. s3://my-bucket/postgres';
    if (!f.backupSecretName) e.backupSecretName = 'Secret with ACCESS_KEY_ID / ACCESS_SECRET_KEY.';
  }
  if (f.backupEnabled) {
    if (!/^[1-9][0-9]*[dwm]$/.test(f.backupRetention)) e.backupRetention = 'e.g. 30d, 4w';
    if (f.backupSchedule.trim().split(/\s+/).length !== 6) e.backupSchedule = 'Six fields, seconds first: "0 0 2 * * *"';
  }
  return e;
}

/**
 * With `explicit`, a disabled pooler or backup is sent with enabled: false
 * instead of being left out, so an edit turns it off but keeps its settings.
 */
export function toSpec(f: ClusterForm, { explicit = false } = {}): Record<string, unknown> {
  const spec: Record<string, any> = {
    postgresVersion: f.postgresVersion,
    instances: f.instances,
    storage: { size: f.storageSize, ...(f.storageClass ? { storageClass: f.storageClass } : {}) },
    resources: {
      requests: { cpu: f.cpu, memory: f.memory },
      // Memory limit == request: PostgreSQL can always use the memory the
      // scheduler reserved for it, and shared_buffers sizing stays predictable.
      limits: { memory: f.memory },
    },
    database: { name: f.databaseName, owner: f.databaseOwner },
    highAvailability: {
      podAntiAffinityType: f.podAntiAffinityType,
      zoneSpread: f.zoneSpread,
      synchronousReplicas: f.synchronousReplicas,
      ...(f.synchronousReplicas > 0 ? { synchronousDataDurability: f.synchronousDataDurability } : {}),
    },
    monitoring: {
      enabled: f.monitoringEnabled,
      grafanaDashboard: { enabled: f.dashboardEnabled },
    },
  };
  if (f.walEnabled) {
    spec.walStorage = { size: f.walSize, ...(f.storageClass ? { storageClass: f.storageClass } : {}) };
  }
  const pooler = {
    enabled: f.poolerEnabled,
    instances: f.poolerInstances,
    poolMode: f.poolMode,
    readOnly: f.poolerReadOnly,
  };
  // Without destination and credentials the cluster uses the Project's bucket.
  const ownStore = !f.backupProjectBucket;
  const backup = {
    enabled: f.backupEnabled,
    ...(ownStore && f.backupDestinationPath ? { destinationPath: f.backupDestinationPath } : {}),
    ...(ownStore && f.backupEndpointURL ? { endpointURL: f.backupEndpointURL } : {}),
    ...(ownStore && f.backupSecretName ? { s3Credentials: { secretName: f.backupSecretName } } : {}),
    retentionPolicy: f.backupRetention,
    schedule: f.backupSchedule,
  };
  if (f.poolerEnabled || explicit) spec.pooler = pooler;
  if (f.backupEnabled || explicit) spec.backup = backup;
  if (f.geoReplication || explicit) {
    spec.geoReplication = {
      enabled: f.geoReplication,
      ...(f.geoInstances > 0 ? { instances: f.geoInstances } : {}),
      // Back to protected is set explicitly, so the patch says so.
      ...(f.primarySite !== 'protected' || explicit ? { primarySite: f.primarySite } : {}),
      ...(f.promotion !== 'Switchover' || explicit ? { promotion: f.promotion } : {}),
    };
  }
  return spec;
}

/** The manifest the form produces, for the preview pane. */
export function toManifest(f: ClusterForm) {
  return {
    apiVersion: 'cnpg.cncp.nl/v1alpha1',
    kind: 'PostgresCluster',
    metadata: {
      name: f.name || '<name>',
      namespace: f.namespace || '<namespace>',
      ...(f.owner ? { labels: { 'backstage.io/owner': f.owner } } : {}),
    },
    spec: toSpec(f),
  };
}

/**
 * The form for an existing cluster. Its spec carries the XRD defaults, so
 * every field is set; the fallbacks only cover objects created before a
 * field existed.
 */
export function fromCluster(cluster: PostgresCluster): ClusterForm {
  const { spec, metadata } = cluster;
  const d = defaultForm(metadata.namespace);
  const ha = spec.highAvailability ?? {};
  const pooler = spec.pooler ?? {};
  const backup = spec.backup ?? {};
  const monitoring = spec.monitoring ?? {};
  const geo = spec.geoReplication ?? {};
  return {
    ...d,
    name: metadata.name,
    owner: metadata.labels?.['backstage.io/owner'] ?? '',
    geoReplication: Boolean(geo.enabled),
    geoInstances: geo.instances ?? 0,
    primarySite: geo.primarySite ?? d.primarySite,
    promotion: geo.promotion ?? d.promotion,
    postgresVersion: spec.postgresVersion ?? d.postgresVersion,
    instances: spec.instances ?? d.instances,
    storageSize: spec.storage?.size ?? d.storageSize,
    storageClass: spec.storage?.storageClass ?? '',
    walEnabled: Boolean(spec.walStorage),
    walSize: spec.walStorage?.size ?? d.walSize,
    cpu: spec.resources?.requests?.cpu ?? d.cpu,
    memory: spec.resources?.requests?.memory ?? d.memory,
    databaseName: spec.database?.name ?? d.databaseName,
    databaseOwner: spec.database?.owner ?? d.databaseOwner,
    podAntiAffinityType: ha.podAntiAffinityType ?? d.podAntiAffinityType,
    zoneSpread: ha.zoneSpread ?? d.zoneSpread,
    synchronousReplicas: ha.synchronousReplicas ?? d.synchronousReplicas,
    synchronousDataDurability: ha.synchronousDataDurability ?? d.synchronousDataDurability,
    poolerEnabled: Boolean(pooler.enabled),
    poolerInstances: pooler.instances ?? d.poolerInstances,
    poolMode: pooler.poolMode ?? d.poolMode,
    poolerReadOnly: pooler.readOnly ?? d.poolerReadOnly,
    backupEnabled: Boolean(backup.enabled),
    backupProjectBucket: Boolean(backup.enabled) && !backup.destinationPath,
    backupDestinationPath: backup.destinationPath ?? '',
    backupEndpointURL: backup.endpointURL ?? '',
    backupSecretName: backup.s3Credentials?.secretName ?? '',
    backupRetention: backup.retentionPolicy ?? d.backupRetention,
    backupSchedule: backup.schedule ?? d.backupSchedule,
    monitoringEnabled: monitoring.enabled ?? d.monitoringEnabled,
    dashboardEnabled: monitoring.grafanaDashboard?.enabled ?? d.dashboardEnabled,
  };
}

/**
 * Fields that can't change on a running cluster without rebuilding it (or
 * that the XRD makes immutable); the edit form shows them read-only.
 */
export const IMMUTABLE: ReadonlyArray<keyof ClusterForm> = [
  'name',
  'namespace',
  'postgresVersion',
  'databaseName',
  'databaseOwner',
  'storageClass',
  'walEnabled',
];

const UNITS: Record<string, number> = { Mi: 1, Gi: 1024, Ti: 1024 * 1024 };

/** A Mi/Gi/Ti quantity in Mi, or NaN. */
export function toMi(quantity: string): number {
  const m = /^([0-9]+)(Mi|Gi|Ti)$/.exec(quantity);
  return m ? Number(m[1]) * UNITS[m[2]] : NaN;
}

/** Volumes can only grow (the XRD enforces the same). */
export function validateEdit(
  original: ClusterForm,
  f: ClusterForm,
): Partial<Record<keyof ClusterForm, string>> {
  const e = validate(f);
  if (!e.storageSize && toMi(f.storageSize) < toMi(original.storageSize)) {
    e.storageSize = `Can grow but not shrink (now ${original.storageSize}).`;
  }
  if (original.walEnabled && !e.walSize && toMi(f.walSize) < toMi(original.walSize)) {
    e.walSize = `Can grow but not shrink (now ${original.walSize}).`;
  }
  return e;
}

/**
 * The JSON merge patch (RFC 7386) that turns `before` into `after`: changed
 * values, null for removed keys, nothing for what stayed the same. Arrays
 * are replaced as a whole, as merge patches do.
 */
export function mergePatch(before: unknown, after: unknown): unknown {
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isObject(before) || !isObject(after)) {
    return JSON.stringify(before) === JSON.stringify(after) ? undefined : after;
  }
  const patch: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!(key in after)) {
      patch[key] = null;
    } else {
      const sub = mergePatch(before[key], after[key]);
      if (sub !== undefined) patch[key] = sub;
    }
  }
  return Object.keys(patch).length ? patch : undefined;
}

/** What an edit changes in the spec: a merge patch, empty when nothing changed. */
export function toEditPatch(original: ClusterForm, f: ClusterForm): Record<string, unknown> {
  return (mergePatch(toSpec(original, { explicit: true }), toSpec(f, { explicit: true })) ??
    {}) as Record<string, unknown>;
}
