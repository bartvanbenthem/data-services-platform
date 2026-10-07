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
     * Grafana base URL; with it the portal links each cluster's dashboard.
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
    catalog?: {
      /** Owner for PostgresClusters without a backstage.io/owner label. */
      defaultOwner?: string;
      /** How often to sync PostgresClusters into the catalog. */
      refreshSeconds?: number;
    };
  };
}
