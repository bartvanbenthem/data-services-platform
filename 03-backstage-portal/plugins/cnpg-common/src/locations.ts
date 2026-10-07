/**
 * Locations: the Kubernetes clusters the platform can run data services in.
 * Each one is a Secret in the platform cluster (namespace
 * `cnpg.locations.namespace`) holding a kubeconfig under the `kubeconfig` key
 * -- the layout Crossplane's provider-kubernetes and provider-helm read --
 * with the settings below as an annotation. The kubeconfig never leaves the
 * backend.
 */

/** Label on every location Secret. */
export const LOCATION_LABEL = 'platform.cncp.nl/location';
/** Annotation on the Secret holding {@link LocationSpec} as JSON. */
export const LOCATION_SPEC_ANNOTATION = 'platform.cncp.nl/location-spec';

export const LOCATION_ENVIRONMENTS = ['production', 'acceptance', 'test', 'development'] as const;
export type LocationEnvironment = (typeof LOCATION_ENVIRONMENTS)[number];

export const LOCATION_PROVIDERS = [
  'on-premises',
  'aks',
  'eks',
  'gke',
  'openshift',
  'kind',
  'other',
] as const;
export type LocationProvider = (typeof LOCATION_PROVIDERS)[number];

/** What a platform admin says about a location (everything but the kubeconfig). */
export interface LocationSpec {
  displayName?: string;
  description?: string;
  environment?: LocationEnvironment;
  provider?: LocationProvider;
  /** Region or data center, e.g. "westeurope" or "dc-amsterdam-2". */
  region?: string;
  /** Team responsible for the cluster (catalog entity ref or group name). */
  owner?: string;
  /** Default StorageClass for databases placed here; empty means the cluster's default. */
  storageClass?: string;
  /** Whether new databases may be placed here. */
  schedulable?: boolean;
}

export type CheckStatus = 'ok' | 'warning' | 'error';

export interface LocationCheck {
  name: string;
  status: CheckStatus;
  message: string;
}

export type LocationHealthStatus = 'healthy' | 'degraded' | 'unreachable';

/** The result of probing a location's API server from the portal backend. */
export interface LocationHealth {
  status: LocationHealthStatus;
  checkedAt: string;
  /** Round trip of the /version call. */
  latencyMs?: number;
  kubernetesVersion?: string;
  nodes?: { ready: number; total: number };
  checks: LocationCheck[];
}

/** Safe-to-show facts about the stored kubeconfig. */
export interface LocationConnection {
  server: string;
  context: string;
  /** "token", "client certificate" or "basic". */
  auth: string;
  /** Default namespace of the context, if any. */
  namespace?: string;
  insecureSkipTlsVerify: boolean;
}

export interface LocationSummary {
  name: string;
  spec: LocationSpec;
  connection: LocationConnection;
  owner?: string;
  createdAt?: string;
  updatedAt?: string;
  health?: LocationHealth;
}
