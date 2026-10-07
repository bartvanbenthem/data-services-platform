import {
  coreServices,
  createBackendModule,
  LoggerService,
  RootConfigService,
  SchedulerServiceTaskRunner,
} from '@backstage/backend-plugin-api';
import {
  ANNOTATION_LOCATION,
  ANNOTATION_ORIGIN_LOCATION,
  Entity,
} from '@backstage/catalog-model';
import {
  catalogProcessingExtensionPoint,
  EntityProvider,
  EntityProviderConnection,
} from '@backstage/plugin-catalog-node';
import {
  CnpgKubernetesService,
  cnpgKubernetesServiceRef,
} from '../service/CnpgKubernetesService';
import {
  CNPG_ANNOTATION,
  PostgresCluster,
  summarize,
} from '@internal/backstage-plugin-cnpg-common';

/**
 * Mirrors every PostgresCluster into the catalog as a Resource of type
 * "postgres-cluster" so databases are searchable, ownable and can be
 * attached to Systems/Components with dependsOn. Owner and system come from
 * the backstage.io/owner and backstage.io/system labels on the XR.
 */
export class PostgresClusterEntityProvider implements EntityProvider {
  #connection?: EntityProviderConnection;

  constructor(
    private readonly k8s: CnpgKubernetesService,
    private readonly taskRunner: SchedulerServiceTaskRunner,
    private readonly logger: LoggerService,
    private readonly options: { defaultOwner: string; appBaseUrl: string; grafanaUrl?: string },
  ) {}

  getProviderName() {
    return 'cnpg-postgresclusters';
  }

  async connect(connection: EntityProviderConnection) {
    this.#connection = connection;
    await this.taskRunner.run({
      id: `${this.getProviderName()}:refresh`,
      fn: () => this.refresh(),
    });
  }

  async refresh() {
    if (!this.#connection) return;
    const clusters = await this.k8s.list();
    await this.#connection.applyMutation({
      type: 'full',
      entities: clusters.map(c => ({
        entity: this.toEntity(c),
        locationKey: this.getProviderName(),
      })),
    });
    this.logger.debug(`Synced ${clusters.length} PostgresClusters into the catalog`);
  }

  toEntity(cluster: PostgresCluster): Entity {
    const { name, namespace, labels = {} } = cluster.metadata;
    const s = summarize(cluster);
    const location = `cnpg:${namespace}/${name}`;
    const dashboardUid = cluster.status?.monitoring?.dashboardUid;
    // Entity links must be absolute URLs.
    const links = [
      {
        url: `${this.options.appBaseUrl.replace(/\/$/, '')}/cnpg/${namespace}/${name}`,
        title: 'CNPG portal',
      },
    ];
    if (dashboardUid && this.options.grafanaUrl) {
      links.push({
        url: `${this.options.grafanaUrl.replace(/\/$/, '')}/d/${dashboardUid}`,
        title: 'Grafana dashboard',
      });
    }
    return {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: {
        // Entity names are unique per catalog namespace, cluster names only
        // per Kubernetes namespace -- so include both.
        name: `${namespace}--${name}`.slice(0, 63),
        title: `${name} (${namespace})`,
        description: `PostgreSQL ${s.postgresVersion ?? ''} on CloudNativePG, ${s.instances} instance(s)`,
        annotations: {
          [ANNOTATION_LOCATION]: location,
          [ANNOTATION_ORIGIN_LOCATION]: location,
          [CNPG_ANNOTATION]: `${namespace}/${name}`,
          'backstage.io/kubernetes-id': name,
          'backstage.io/kubernetes-namespace': namespace,
        },
        tags: ['postgresql', 'cnpg', `pg${s.postgresVersion ?? ''}`].filter(t => t !== 'pg'),
        links,
      },
      spec: {
        type: 'postgres-cluster',
        owner: labels['backstage.io/owner'] ?? this.options.defaultOwner,
        ...(labels['backstage.io/system'] ? { system: labels['backstage.io/system'] } : {}),
      },
    };
  }
}

export function readCatalogOptions(config: RootConfigService) {
  return {
    defaultOwner: config.getOptionalString('cnpg.catalog.defaultOwner') ?? 'group:default/guests',
    appBaseUrl: config.getString('app.baseUrl'),
    grafanaUrl: config.getOptionalString('cnpg.grafanaUrl'),
  };
}

/**
 * Catalog module registering {@link PostgresClusterEntityProvider}.
 *
 * @public
 */
export const catalogModuleCnpg = createBackendModule({
  pluginId: 'catalog',
  moduleId: 'cnpg-postgresclusters',
  register(env) {
    env.registerInit({
      deps: {
        catalog: catalogProcessingExtensionPoint,
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        scheduler: coreServices.scheduler,
        k8s: cnpgKubernetesServiceRef,
      },
      async init({ catalog, config, logger, scheduler, k8s }) {
        const seconds = config.getOptionalNumber('cnpg.catalog.refreshSeconds') ?? 30;
        catalog.addEntityProvider(
          new PostgresClusterEntityProvider(
            k8s,
            scheduler.createScheduledTaskRunner({
              frequency: { seconds },
              timeout: { seconds: 60 },
            }),
            logger,
            readCatalogOptions(config),
          ),
        );
      },
    });
  },
});
