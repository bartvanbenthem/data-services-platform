import {
  coreServices,
  createServiceFactory,
  createServiceRef,
  LoggerService,
  RootConfigService,
} from '@backstage/backend-plugin-api';
import {
  ConflictError,
  InputError,
  NotAllowedError,
  NotFoundError,
} from '@backstage/errors';
import {
  ApiException,
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
  KubernetesObjectApi,
  PatchStrategy,
} from '@kubernetes/client-node';
import {
  ClusterEvent,
  InstancePod,
  PostgresCluster,
  PostgresClusterDetails,
  Project,
  PROJECT_GROUP,
  PROJECT_KIND,
  PROJECT_PLURAL,
  PROJECT_VERSION,
  summarize,
  XR_GROUP,
  XR_KIND,
  XR_PLURAL,
  XR_VERSION,
} from '@internal/backstage-plugin-cnpg-common';

const FIELD_MANAGER = 'backstage-cnpg';

/**
 * Talks to the Kubernetes API of the platform cluster that runs Crossplane +
 * CNPG. Credentials come from the in-cluster ServiceAccount when Backstage
 * runs inside Kubernetes, otherwise from the local kubeconfig (optionally a
 * specific context via `cnpg.kubernetes.context`).
 */
export class CnpgKubernetesService {
  readonly #custom: CustomObjectsApi;
  readonly #core: CoreV1Api;
  readonly #objects: KubernetesObjectApi;
  readonly #logger: LoggerService;

  static fromConfig(config: RootConfigService, logger: LoggerService) {
    const kc = new KubeConfig();
    const kubeconfigPath = config.getOptionalString('cnpg.kubernetes.kubeconfig');
    if (kubeconfigPath) {
      kc.loadFromFile(kubeconfigPath);
    } else {
      kc.loadFromDefault();
    }
    const context = config.getOptionalString('cnpg.kubernetes.context');
    if (context) {
      kc.setCurrentContext(context);
    }
    logger.info(
      `Using Kubernetes cluster ${kc.getCurrentCluster()?.server ?? '(unknown)'} for PostgresClusters`,
    );
    return new CnpgKubernetesService(kc, logger);
  }

  constructor(kc: KubeConfig, logger: LoggerService) {
    this.#custom = kc.makeApiClient(CustomObjectsApi);
    this.#core = kc.makeApiClient(CoreV1Api);
    this.#objects = KubernetesObjectApi.makeApiClient(kc);
    this.#logger = logger;
  }

  async list(namespace?: string): Promise<PostgresCluster[]> {
    const res = await this.#call(() =>
      namespace
        ? this.#custom.listNamespacedCustomObject({
            group: XR_GROUP,
            version: XR_VERSION,
            plural: XR_PLURAL,
            namespace,
          })
        : this.#custom.listClusterCustomObject({
            group: XR_GROUP,
            version: XR_VERSION,
            plural: XR_PLURAL,
          }),
    );
    return (res.items ?? []) as PostgresCluster[];
  }

  async get(namespace: string, name: string): Promise<PostgresCluster> {
    return (await this.#call(
      () =>
        this.#custom.getNamespacedCustomObject({
          group: XR_GROUP,
          version: XR_VERSION,
          plural: XR_PLURAL,
          namespace,
          name,
        }),
      `PostgresCluster ${namespace}/${name}`,
    )) as PostgresCluster;
  }

  async details(namespace: string, name: string): Promise<PostgresClusterDetails> {
    const resource = await this.get(namespace, name);
    const [pods, events, cnpg] = await Promise.all([
      this.#pods(namespace, name),
      this.#events(namespace, name),
      this.#custom
        .getNamespacedCustomObject({
          group: 'postgresql.cnpg.io',
          version: 'v1',
          plural: 'clusters',
          namespace,
          name,
        })
        .catch(() => undefined),
    ]);
    return {
      summary: summarize(resource),
      resource,
      pods,
      events,
      cnpgStatus: cnpg?.status,
    };
  }

  /**
   * Creates or updates a PostgresCluster with server-side apply. The spec is
   * passed through as-is: the API server validates it against the XRD schema
   * (defaults, enums, CEL rules) and its errors are returned to the caller.
   */
  async apply(options: {
    namespace: string;
    name: string;
    spec: Record<string, unknown>;
    labels?: Record<string, string>;
    createOnly?: boolean;
    dryRun?: boolean;
  }): Promise<PostgresCluster> {
    const { namespace, name, spec, labels, createOnly, dryRun } = options;
    if (createOnly) {
      const existing = await this.get(namespace, name).catch(e => {
        if (e instanceof NotFoundError) return undefined;
        throw e;
      });
      if (existing) {
        throw new ConflictError(`PostgresCluster ${namespace}/${name} already exists`);
      }
    }
    const body = {
      apiVersion: `${XR_GROUP}/${XR_VERSION}`,
      kind: XR_KIND,
      metadata: {
        name,
        namespace,
        labels: { ...labels, 'app.kubernetes.io/managed-by': 'backstage' },
      },
      spec,
    };
    const result = await this.#call(() =>
      this.#objects.patch(
        body,
        undefined,
        dryRun ? 'All' : undefined,
        FIELD_MANAGER,
        true,
        PatchStrategy.ServerSideApply,
      ),
    );
    if (!dryRun) {
      this.#logger.info(`Applied PostgresCluster ${namespace}/${name}`);
    }
    return result as unknown as PostgresCluster;
  }

  async delete(namespace: string, name: string): Promise<void> {
    await this.#call(
      () =>
        this.#custom.deleteNamespacedCustomObject({
          group: XR_GROUP,
          version: XR_VERSION,
          plural: XR_PLURAL,
          namespace,
          name,
          propagationPolicy: 'Foreground',
        }),
      `PostgresCluster ${namespace}/${name}`,
    );
    this.#logger.info(`Deleted PostgresCluster ${namespace}/${name}`);
  }

  /**
   * Every Project. An empty list when the Project API isn't installed, so
   * the portal keeps working on clusters with only the PostgresCluster API.
   */
  async listProjects(): Promise<Project[]> {
    try {
      const res = await this.#call(() =>
        this.#custom.listClusterCustomObject({
          group: PROJECT_GROUP,
          version: PROJECT_VERSION,
          plural: PROJECT_PLURAL,
        }),
      );
      return (res.items ?? []) as Project[];
    } catch (e) {
      if (e instanceof NotFoundError) return [];
      throw e;
    }
  }

  async getProject(name: string): Promise<Project> {
    return (await this.#call(
      () =>
        this.#custom.getClusterCustomObject({
          group: PROJECT_GROUP,
          version: PROJECT_VERSION,
          plural: PROJECT_PLURAL,
          name,
        }),
      `Project ${name}`,
    )) as Project;
  }

  /**
   * Creates a Project with server-side apply; like {@link apply}, the API
   * server validates the spec (and the name) against the XRD.
   */
  async applyProject(options: {
    name: string;
    spec: Record<string, unknown>;
    labels?: Record<string, string>;
    createOnly?: boolean;
    dryRun?: boolean;
  }): Promise<Project> {
    const { name, spec, labels, createOnly, dryRun } = options;
    if (createOnly) {
      const existing = await this.getProject(name).catch(e => {
        if (e instanceof NotFoundError) return undefined;
        throw e;
      });
      if (existing) {
        throw new ConflictError(`Project ${name} already exists`);
      }
    }
    const body = {
      apiVersion: `${PROJECT_GROUP}/${PROJECT_VERSION}`,
      kind: PROJECT_KIND,
      metadata: {
        name,
        labels: { ...labels, 'app.kubernetes.io/managed-by': 'backstage' },
      },
      spec,
    };
    const result = await this.#call(() =>
      this.#objects.patch(
        body,
        undefined,
        dryRun ? 'All' : undefined,
        FIELD_MANAGER,
        true,
        PatchStrategy.ServerSideApply,
      ),
    );
    if (!dryRun) {
      this.#logger.info(`Applied Project ${name}`);
    }
    return result as unknown as Project;
  }

  async namespaces(): Promise<string[]> {
    const res = await this.#call(() => this.#core.listNamespace());
    return res.items
      .map(n => n.metadata?.name ?? '')
      .filter(n => n && !n.startsWith('kube-'))
      .sort();
  }

  async #pods(namespace: string, name: string): Promise<InstancePod[]> {
    const res = await this.#call(() =>
      this.#core.listNamespacedPod({
        namespace,
        labelSelector: `cnpg.io/cluster=${name}`,
      }),
    );
    const label = (p: (typeof res.items)[number], key: string) => p.metadata?.labels?.[key];
    return res.items
      // Finished bootstrap/join Job pods (initdb, join, ...) are just noise.
      .filter(p => !(label(p, 'cnpg.io/jobRole') && p.status?.phase === 'Succeeded'))
      .map(p => ({
        name: p.metadata?.name ?? '',
        role:
          label(p, 'cnpg.io/instanceRole') ??
          (label(p, 'cnpg.io/jobRole') ? `job: ${label(p, 'cnpg.io/jobRole')}` : undefined) ??
          label(p, 'cnpg.io/podRole') ??
          'unknown',
        phase: p.status?.phase ?? 'Unknown',
        ready:
          p.status?.conditions?.some(c => c.type === 'Ready' && c.status === 'True') ??
          false,
        node: p.spec?.nodeName,
        restarts: (p.status?.containerStatuses ?? []).reduce(
          (sum, c) => sum + (c.restartCount ?? 0),
          0,
        ),
        createdAt: toIso(p.metadata?.creationTimestamp),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async #events(namespace: string, name: string): Promise<ClusterEvent[]> {
    const res = await this.#call(() => this.#core.listNamespacedEvent({ namespace }));
    // The XR, the Cluster, poolers, backups, pods and PVCs are all named
    // "<name>" or "<name>-...".
    const belongs = (obj = '') => obj === name || obj.startsWith(`${name}-`);
    return res.items
      .filter(e => belongs(e.involvedObject?.name))
      .map(e => ({
        type: e.type ?? 'Normal',
        reason: e.reason ?? '',
        message: e.message ?? '',
        object: `${e.involvedObject?.kind}/${e.involvedObject?.name}`,
        count: e.count ?? 1,
        lastSeen: toIso(e.lastTimestamp ?? e.eventTime ?? e.metadata?.creationTimestamp),
      }))
      .sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? ''))
      .slice(0, 15);
  }

  /** Maps Kubernetes API errors onto Backstage's error types (and HTTP codes). */
  async #call<T>(fn: () => Promise<T>, what?: string): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ApiException) {
        const message = apiMessage(e);
        switch (e.code) {
          case 404:
            throw new NotFoundError(what ? `${what} not found` : message);
          case 409:
            throw new ConflictError(message);
          case 400:
          case 422:
            throw new InputError(message);
          case 401:
          case 403:
            throw new NotAllowedError(message);
          default:
            throw new Error(`Kubernetes API error ${e.code}: ${message}`);
        }
      }
      throw e;
    }
  }
}

function apiMessage(e: ApiException<unknown>): string {
  const body = e.body as any;
  if (typeof body === 'string') {
    try {
      return JSON.parse(body).message ?? body;
    } catch {
      return body;
    }
  }
  return body?.message ?? e.message;
}

function toIso(value: unknown): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export const cnpgKubernetesServiceRef = createServiceRef<CnpgKubernetesService>({
  id: 'cnpg.kubernetes',
  defaultFactory: async service =>
    createServiceFactory({
      service,
      deps: { config: coreServices.rootConfig, logger: coreServices.logger },
      factory: ({ config, logger }) => CnpgKubernetesService.fromConfig(config, logger),
    }),
});
