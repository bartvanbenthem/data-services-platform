import {
  coreServices,
  createServiceFactory,
  createServiceRef,
  LoggerService,
} from '@backstage/backend-plugin-api';
import { ConflictError, NotFoundError } from '@backstage/errors';
import {
  ApiException,
  ApisApi,
  CoreV1Api,
  Health,
  KubeConfig,
  V1Secret,
  VersionApi,
} from '@kubernetes/client-node';
import {
  LOCATION_LABEL,
  LOCATION_SPEC_ANNOTATION,
  LocationCheck,
  LocationConnection,
  LocationHealth,
  LocationSpec,
  LocationSummary,
} from '@internal/backstage-plugin-cnpg-common';
import { apiMessage, cnpgKubernetesServiceRef, kubeCall } from './CnpgKubernetesService';
import { parseKubeconfig } from './kubeconfig';

const KUBECONFIG_KEY = 'kubeconfig';
const OWNER_LABEL = 'backstage.io/owner';
/** Per call; an unreachable location answers the list page within a few seconds. */
const PROBE_TIMEOUT_MS = 5_000;
/** How long a health result is reused before the next request probes again. */
const HEALTH_TTL_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms = PROBE_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** One line for an error from a location's API server, without stack noise. */
function describe(e: unknown): string {
  if (e instanceof ApiException) {
    if (e.code === 401) return 'credentials rejected (401 Unauthorized)';
    if (e.code === 403) return `not allowed (403): ${apiMessage(e)}`;
    return `HTTP ${e.code}: ${apiMessage(e)}`;
  }
  const err = e as Error & { cause?: Error; code?: string };
  return (err.cause?.message ?? err.message ?? String(e)).split('\n')[0];
}

/**
 * Probes a location's API server: reachable and authenticated (/version),
 * ready (/readyz), nodes Ready, and whether CloudNativePG is installed.
 * Unreachable when /version fails; degraded when any check is an error.
 */
export async function probe(kubeconfig: string): Promise<LocationHealth> {
  const kc = new KubeConfig();
  kc.loadFromString(kubeconfig);
  const checkedAt = new Date().toISOString();
  const checks: LocationCheck[] = [];

  const started = Date.now();
  let version;
  try {
    version = await withTimeout(kc.makeApiClient(VersionApi).getCode());
  } catch (e) {
    return {
      status: 'unreachable',
      checkedAt,
      checks: [{ name: 'API server', status: 'error', message: describe(e) }],
    };
  }
  const latencyMs = Date.now() - started;
  checks.push({
    name: 'API server',
    status: 'ok',
    message: `Kubernetes ${version.gitVersion} answered in ${latencyMs} ms`,
  });

  const [ready, nodes, groups] = await Promise.allSettled([
    new Health(kc).readyz({ signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) } as any),
    withTimeout(kc.makeApiClient(CoreV1Api).listNode()),
    withTimeout(kc.makeApiClient(ApisApi).getAPIVersions()),
  ]);

  if (ready.status === 'fulfilled') {
    checks.push(
      ready.value
        ? { name: 'Readiness', status: 'ok', message: '/readyz reports ready' }
        : { name: 'Readiness', status: 'error', message: '/readyz reports not ready' },
    );
  } else {
    checks.push({ name: 'Readiness', status: 'warning', message: describe(ready.reason) });
  }

  let nodeCount: LocationHealth['nodes'];
  if (nodes.status === 'fulfilled') {
    const total = nodes.value.items.length;
    const readyNodes = nodes.value.items.filter(n =>
      n.status?.conditions?.some(c => c.type === 'Ready' && c.status === 'True'),
    ).length;
    nodeCount = { ready: readyNodes, total };
    let status: LocationCheck['status'] = 'ok';
    if (readyNodes < total) status = 'warning';
    if (readyNodes === 0) status = 'error';
    checks.push({ name: 'Nodes', status, message: `${readyNodes} of ${total} nodes Ready` });
  } else {
    checks.push({
      name: 'Nodes',
      status: 'warning',
      message: `could not list nodes: ${describe(nodes.reason)}`,
    });
  }

  if (groups.status === 'fulfilled') {
    const cnpg = groups.value.groups.some(g => g.name === 'postgresql.cnpg.io');
    checks.push(
      cnpg
        ? { name: 'CloudNativePG', status: 'ok', message: 'operator API (postgresql.cnpg.io) installed' }
        : { name: 'CloudNativePG', status: 'warning', message: 'operator not installed' },
    );
  } else {
    checks.push({ name: 'CloudNativePG', status: 'warning', message: describe(groups.reason) });
  }

  return {
    status: checks.some(c => c.status === 'error') ? 'degraded' : 'healthy',
    checkedAt,
    latencyMs,
    kubernetesVersion: version.gitVersion,
    nodes: nodeCount,
    checks,
  };
}

/**
 * Locations (Kubernetes clusters the platform can use) stored as Secrets in
 * one namespace of the platform cluster; see LOCATION_LABEL in the common
 * package for the layout. Health is probed from this backend and cached
 * briefly, so list pages don't hammer every API server.
 */
export class LocationService {
  readonly #core: CoreV1Api;
  readonly #namespace: string;
  readonly #logger: LoggerService;
  readonly #health = new Map<string, { at: number; result: Promise<LocationHealth> }>();

  constructor(options: { kubeConfig: KubeConfig; namespace: string; logger: LoggerService }) {
    this.#core = options.kubeConfig.makeApiClient(CoreV1Api);
    this.#namespace = options.namespace;
    this.#logger = options.logger;
  }

  async list(): Promise<LocationSummary[]> {
    const res = await kubeCall(() =>
      this.#core.listNamespacedSecret({
        namespace: this.#namespace,
        labelSelector: `${LOCATION_LABEL}=true`,
      }),
    );
    const items = await Promise.all(res.items.map(s => this.#withHealth(s)));
    return items.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(name: string, options: { refresh?: boolean } = {}): Promise<LocationSummary> {
    return this.#withHealth(await this.#secret(name), options.refresh);
  }

  /** Validates and probes a location without storing it ("Test connection"). */
  async test(options: { kubeconfig: string; context?: string }): Promise<LocationHealth> {
    return probe(parseKubeconfig(options.kubeconfig, options.context).kubeconfig);
  }

  async create(options: {
    name: string;
    kubeconfig: string;
    context?: string;
    spec: LocationSpec;
  }): Promise<LocationSummary> {
    const { name, spec } = options;
    const { kubeconfig } = parseKubeconfig(options.kubeconfig, options.context);
    const exists = await this.#secret(name).then(
      () => true,
      e => {
        if (e instanceof NotFoundError) return false;
        throw e;
      },
    );
    if (exists) throw new ConflictError(`Location ${name} already exists`);

    const body: V1Secret = {
      metadata: { name, namespace: this.#namespace, ...this.#meta(spec) },
      type: 'Opaque',
      stringData: { [KUBECONFIG_KEY]: kubeconfig },
    };
    let created: V1Secret;
    try {
      created = await kubeCall(() =>
        this.#core.createNamespacedSecret({ namespace: this.#namespace, body }),
      );
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
      // First location: the namespace isn't there yet (in-cluster, deploy/ creates it).
      await kubeCall(() =>
        this.#core.createNamespace({ body: { metadata: { name: this.#namespace } } }),
      );
      created = await kubeCall(() =>
        this.#core.createNamespacedSecret({ namespace: this.#namespace, body }),
      );
    }
    this.#logger.info(`Added location ${name}`);
    this.#health.delete(name);
    return this.#withHealth(created);
  }

  /** Replaces the settings and, when given, the kubeconfig. */
  async update(
    name: string,
    options: { spec: LocationSpec; kubeconfig?: string; context?: string },
  ): Promise<LocationSummary> {
    const secret = await this.#secret(name);
    const meta = this.#meta(options.spec);
    const labels = { ...secret.metadata?.labels, ...meta.labels };
    if (!options.spec.owner) delete labels[OWNER_LABEL];
    const body: V1Secret = {
      ...secret,
      metadata: {
        ...secret.metadata,
        labels,
        annotations: { ...secret.metadata?.annotations, ...meta.annotations },
      },
    };
    if (options.kubeconfig) {
      const { kubeconfig } = parseKubeconfig(options.kubeconfig, options.context);
      body.data = { ...body.data, [KUBECONFIG_KEY]: Buffer.from(kubeconfig).toString('base64') };
    }
    const updated = await kubeCall(() =>
      this.#core.replaceNamespacedSecret({ namespace: this.#namespace, name, body }),
    );
    this.#logger.info(
      `Updated location ${name}${options.kubeconfig ? ' (new kubeconfig)' : ''}`,
    );
    this.#health.delete(name);
    return this.#withHealth(updated);
  }

  async delete(name: string): Promise<void> {
    await this.#secret(name);
    await kubeCall(
      () => this.#core.deleteNamespacedSecret({ namespace: this.#namespace, name }),
      `Location ${name}`,
    );
    this.#health.delete(name);
    this.#logger.info(`Removed location ${name}`);
  }

  #meta(spec: LocationSpec) {
    return {
      labels: {
        [LOCATION_LABEL]: 'true',
        'app.kubernetes.io/managed-by': 'backstage',
        ...(spec.owner ? { [OWNER_LABEL]: spec.owner } : {}),
      },
      annotations: { [LOCATION_SPEC_ANNOTATION]: JSON.stringify(spec) },
    };
  }

  /** The Secret of a location; anything without the label isn't one. */
  async #secret(name: string): Promise<V1Secret> {
    const secret = await kubeCall(
      () => this.#core.readNamespacedSecret({ namespace: this.#namespace, name }),
      `Location ${name}`,
    );
    if (secret.metadata?.labels?.[LOCATION_LABEL] !== 'true') {
      throw new NotFoundError(`Location ${name} not found`);
    }
    return secret;
  }

  async #withHealth(secret: V1Secret, refresh = false): Promise<LocationSummary> {
    const name = secret.metadata?.name ?? '';
    const kubeconfig = Buffer.from(secret.data?.[KUBECONFIG_KEY] ?? '', 'base64').toString();
    let spec: LocationSpec = {};
    try {
      spec = JSON.parse(secret.metadata?.annotations?.[LOCATION_SPEC_ANNOTATION] ?? '{}');
    } catch {
      // Hand-edited annotation; show the location without its settings.
    }

    let connection: LocationConnection;
    let health: Promise<LocationHealth>;
    try {
      connection = parseKubeconfig(kubeconfig).connection;
      health = this.#probeCached(name, kubeconfig, refresh);
    } catch (e) {
      // Edited outside the portal into something we won't load.
      connection = { server: '-', context: '-', auth: '-', insecureSkipTlsVerify: false };
      health = Promise.resolve({
        status: 'unreachable',
        checkedAt: new Date().toISOString(),
        checks: [{ name: 'kubeconfig', status: 'error', message: (e as Error).message }],
      });
    }

    return {
      name,
      spec,
      connection,
      owner: spec.owner,
      createdAt: secret.metadata?.creationTimestamp
        ? new Date(secret.metadata.creationTimestamp).toISOString()
        : undefined,
      health: await health,
    };
  }

  /** Cached probe; concurrent requests share one in-flight probe. */
  #probeCached(name: string, kubeconfig: string, refresh: boolean): Promise<LocationHealth> {
    const cached = this.#health.get(name);
    if (!refresh && cached && Date.now() - cached.at < HEALTH_TTL_MS) return cached.result;
    const result = probe(kubeconfig).catch(
      (e): LocationHealth => ({
        status: 'unreachable',
        checkedAt: new Date().toISOString(),
        checks: [{ name: 'API server', status: 'error', message: describe(e) }],
      }),
    );
    this.#health.set(name, { at: Date.now(), result });
    return result;
  }
}

export const locationServiceRef = createServiceRef<LocationService>({
  id: 'cnpg.locations',
  defaultFactory: async service =>
    createServiceFactory({
      service,
      deps: {
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        k8s: cnpgKubernetesServiceRef,
      },
      factory: ({ config, logger, k8s }) =>
        new LocationService({
          kubeConfig: k8s.kubeConfig,
          namespace: config.getOptionalString('cnpg.locations.namespace') ?? 'cnpg-locations',
          logger,
        }),
    }),
});
