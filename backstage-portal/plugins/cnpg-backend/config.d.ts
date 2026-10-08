export interface Config {
  cnpg?: {
    kubernetes?: {
      /**
       * Path to a kubeconfig file. Defaults to the in-cluster ServiceAccount
       * when running in Kubernetes, else $KUBECONFIG / ~/.kube/config.
       */
      kubeconfig?: string;
      /** kubeconfig context to use instead of the current one. */
      context?: string;
    };
    /**
     * Grafana base URL; with it the portal embeds and links each cluster's
     * CNPG dashboard. "{namespace}" is replaced by the cluster's namespace.
     * @visibility frontend
     */
    grafanaUrl?: string;
    /**
     * Namespace preselected in the create form.
     * @visibility frontend
     */
    defaultNamespace?: string;
    /**
     * StorageClasses offered in the create form.
     * @visibility frontend
     */
    storageClasses?: string[];
    locations?: {
      /**
       * Namespace in the platform cluster holding one Secret (with a
       * kubeconfig) per location. Defaults to "cnpg-locations".
       */
      namespace?: string;
    };
    catalog?: {
      /** Owner for PostgresClusters without a backstage.io/owner label. */
      defaultOwner?: string;
      /** How often to sync PostgresClusters into the catalog. */
      refreshSeconds?: number;
    };
  };
}
