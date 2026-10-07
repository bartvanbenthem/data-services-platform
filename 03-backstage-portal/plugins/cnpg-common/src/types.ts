/**
 * Shapes of the cnpg.cncp.nl/v1alpha1 PostgresCluster API served by
 * 02-crossplane-api. The XRD is the source of truth (and the API server
 * validates every write against it); these types only cover what the portal
 * reads or sends.
 */

export const XR_GROUP = 'cnpg.cncp.nl';
export const XR_VERSION = 'v1alpha1';
export const XR_PLURAL = 'postgresclusters';
export const XR_KIND = 'PostgresCluster';

/** Annotation on catalog Resource entities: "<namespace>/<name>" of their PostgresCluster. */
export const CNPG_ANNOTATION = 'cnpg.cncp.nl/postgrescluster';

export interface Condition {
  type: string;
  status: 'True' | 'False' | 'Unknown';
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

export interface PostgresClusterStatus {
  ready?: boolean;
  phase?: string;
  instances?: number;
  readyInstances?: number;
  currentPrimary?: string;
  image?: string;
  message?: string;
  endpoints?: Record<string, string>;
  secrets?: { app?: string; superuser?: string };
  backup?: { lastSuccessfulBackup?: string; firstRecoverabilityPoint?: string };
  monitoring?: { dashboardUid?: string };
  conditions?: Condition[];
}

export interface PostgresCluster {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace: string;
    uid?: string;
    creationTimestamp?: string;
    deletionTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec: Record<string, any>;
  status?: PostgresClusterStatus;
}

/** One row in the portal's cluster list. */
export interface PostgresClusterSummary {
  name: string;
  namespace: string;
  postgresVersion?: number;
  instances: number;
  readyInstances: number;
  phase: string;
  currentPrimary?: string;
  /** Crossplane's Ready condition: every composed object exists and the Cluster is healthy. */
  ready: boolean;
  synced: boolean;
  deleting: boolean;
  message?: string;
  owner?: string;
  pooler: boolean;
  backup: boolean;
  createdAt?: string;
}

export interface InstancePod {
  name: string;
  role: string;
  phase: string;
  ready: boolean;
  node?: string;
  restarts: number;
  createdAt?: string;
}

export interface ClusterEvent {
  type: string;
  reason: string;
  message: string;
  object: string;
  count: number;
  lastSeen?: string;
}

/** Everything the detail page shows, gathered in one round-trip. */
export interface PostgresClusterDetails {
  summary: PostgresClusterSummary;
  resource: PostgresCluster;
  pods: InstancePod[];
  events: ClusterEvent[];
  /** Live CNPG Cluster status (instance roles, timeline, certificates...). */
  cnpgStatus?: Record<string, any>;
}

export function conditionStatus(
  cluster: PostgresCluster,
  type: string,
): Condition | undefined {
  return cluster.status?.conditions?.find(c => c.type === type);
}

export function summarize(cluster: PostgresCluster): PostgresClusterSummary {
  const { metadata, spec, status } = cluster;
  return {
    name: metadata.name,
    namespace: metadata.namespace,
    postgresVersion: spec.postgresVersion,
    instances: spec.instances ?? 0,
    readyInstances: status?.readyInstances ?? 0,
    phase: status?.phase ?? 'Pending',
    currentPrimary: status?.currentPrimary || undefined,
    ready: conditionStatus(cluster, 'Ready')?.status === 'True',
    synced: conditionStatus(cluster, 'Synced')?.status === 'True',
    deleting: Boolean(metadata.deletionTimestamp),
    message: status?.message,
    owner: metadata.labels?.['backstage.io/owner'],
    pooler: Boolean(spec.pooler?.enabled),
    backup: Boolean(spec.backup?.enabled),
    createdAt: metadata.creationTimestamp,
  };
}
