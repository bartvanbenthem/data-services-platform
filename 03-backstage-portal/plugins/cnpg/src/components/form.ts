/**
 * Create-form state and its mapping onto a PostgresCluster spec. Only what
 * the form exposes is sent; everything else falls back to the XRD defaults,
 * and the API server validates the result against the XRD.
 */

export interface ClusterForm {
  name: string;
  namespace: string;
  owner: string;
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
  if (f.backupEnabled) {
    if (!/^s3:\/\/.+/.test(f.backupDestinationPath)) e.backupDestinationPath = 'e.g. s3://my-bucket/postgres';
    if (!f.backupSecretName) e.backupSecretName = 'Secret with ACCESS_KEY_ID / ACCESS_SECRET_KEY.';
    if (!/^[1-9][0-9]*[dwm]$/.test(f.backupRetention)) e.backupRetention = 'e.g. 30d, 4w';
    if (f.backupSchedule.trim().split(/\s+/).length !== 6) e.backupSchedule = 'Six fields, seconds first: "0 0 2 * * *"';
  }
  return e;
}

export function toSpec(f: ClusterForm): Record<string, unknown> {
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
  if (f.poolerEnabled) {
    spec.pooler = {
      enabled: true,
      instances: f.poolerInstances,
      poolMode: f.poolMode,
      readOnly: f.poolerReadOnly,
    };
  }
  if (f.backupEnabled) {
    spec.backup = {
      enabled: true,
      destinationPath: f.backupDestinationPath,
      ...(f.backupEndpointURL ? { endpointURL: f.backupEndpointURL } : {}),
      s3Credentials: { secretName: f.backupSecretName },
      retentionPolicy: f.backupRetention,
      schedule: f.backupSchedule,
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
