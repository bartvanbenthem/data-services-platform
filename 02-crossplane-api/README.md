# 02-crossplane-api: the `PostgresCluster` API

A Crossplane **v2** namespaced composite resource, `cnpg.cncp.nl/v1alpha1 PostgresCluster`.
It turns ~10 lines of YAML into a production CloudNativePG setup.

```yaml
apiVersion: cnpg.cncp.nl/v1alpha1
kind: PostgresCluster
metadata:
  name: orders-db
  namespace: demo
spec:
  storage:
    size: 10Gi
```

See [`examples/production.yaml`](examples/production.yaml) for every option, and
[`apis/postgrescluster/definition.yaml`](apis/postgrescluster/definition.yaml) for the schema
(defaults, enums and CEL rules, all enforced by the API server).

## What gets composed

| Composed resource | When | Notes |
|---|---|---|
| `postgresql.cnpg.io/v1 Cluster` | always | Image from the `ClusterImageCatalog` by major version; pod anti-affinity, zone spread, quorum sync replication, managed roles, optional WAL volume and external LoadBalancer. `inheritedMetadata` puts `cnpg.cncp.nl/postgrescluster` and `backstage.io/kubernetes-id` on every pod/PVC/Service. |
| `barmancloud.cnpg.io/v1 ObjectStore` + `ScheduledBackup` | `backup.enabled` | Barman Cloud **plugin**, replacing the deprecated in-tree `barmanObjectStore`. WAL archiving, an immediate first base backup, then on schedule, with retention. |
| `postgresql.cnpg.io/v1 Database` (per entry) | `databases[]` | Declarative extra databases and extensions |
| `postgresql.cnpg.io/v1 Pooler` (rw, optionally ro) | `pooler.enabled` | PgBouncer with anti-affinity |
| `monitoring.coreos.com/v1 PodMonitor` (instances, poolers) | `monitoring.enabled` (default) | Exposes the Prometheus metrics: the CNPG exporter on `:9187`, PgBouncer on `:9127`. Replaces the deprecated `Cluster.spec.monitoring.enablePodMonitor`. |
| `monitoring.coreos.com/v1 PrometheusRule` | `monitoring.prometheusRule.enabled` (default) | The 19 upstream CNPG alerts, scoped to this cluster; `excludeRules` drops some |
| `grafana.integreatly.org/v1beta1 GrafanaDashboard` | `monitoring.grafanaDashboard.enabled` (default) | **The same CloudNativePG dashboard** as `cn-paas-operator-poc`, with a per-cluster uid/title and the namespace/cluster variables preselected |

The XR's `status` mirrors CNPG: phase, ready/total instances, current primary, image, endpoints
(`-rw`/`-ro`/`-r`/pooler), credential Secret names, last backup and recovery window, and the dashboard
uid. A `PostgresReady` condition sits next to Crossplane's own `Ready`/`Synced`.

## Differences from `cp-controlplane-poc` (v1 style)

- `apiextensions.crossplane.io/v2` XRD with `scope: Namespaced`: no claim/XR pair, users create the
  XR directly in their namespace.
- CNPG/Prometheus/Grafana objects are **composed directly**. There are no provider-kubernetes `Object`
  wrappers, no provider, and no ClusterProviderConfig. Status is read straight from
  `.observed.resources[...]`. RBAC is a ClusterRole for exactly those kinds, aggregated into
  Crossplane's own ServiceAccount ([`install/rbac.yaml`](install/rbac.yaml)), instead of `*/*`.
- Readiness is set explicitly per resource (`gotemplating.fn.crossplane.io/ready`), so
  `function-auto-ready` isn't needed. The custom condition uses `ClaimConditions` instead of
  hand-written `status.conditions`.
- The dashboard JSON and alert rules are kept as readable sources in `src/` and embedded by a
  generator. `composition.yaml` is generated, so don't edit it by hand.

## Layout

```
apis/postgrescluster/definition.yaml       XRD (the API contract)
apis/postgrescluster/composition.tmpl.yaml composition source -- edit this
apis/postgrescluster/composition.yaml      GENERATED (make generate)
src/dashboards/cnpg-cluster.json           CNPG Grafana dashboard (Apache-2.0)
src/alerts/cnpg-cluster-rules.yaml         CNPG alerts from the cnpg/cluster chart (hack/refresh-alerts.sh)
hack/generate.py                           embeds src/ into the composition (escapes {{ }})
install/                                   Crossplane, function-go-templating, RBAC, install/uninstall
examples/                                  minimal and production PostgresClusters
tests/render/                              offline render + schema validation tests
```

## Install

```sh
install/install.sh                        # Crossplane 2.4.2 + everything above
SKIP_CROSSPLANE=true install/install.sh   # Crossplane already installed
kubectl apply -f examples/minimal.yaml
kubectl get postgrescluster -A
```

The Composition is applied with `--server-side`, because the embedded dashboard exceeds the
client-side `last-applied-configuration` annotation limit.

## Develop

```sh
make generate   # after editing composition.tmpl.yaml or src/
make test       # crossplane render (3 cases × empty/observed), crossplane resource validate
                # against the CNPG/Barman/Prometheus/Grafana CRDs, semantic assertions
../hack/e2e-kind.sh   # the real thing on kind
```

## Notes

- Grafana: the default `instanceSelector` is `dashboards.paas.cncp.nl/scope: <namespace>`, which
  matches the GrafanaInstances of the paas platform. Override it with
  `monitoring.grafanaDashboard.instanceSelector`.
- Prometheus: if your Prometheus selects monitors by label (e.g. kube-prometheus-stack's
  `release`), set `monitoring.podMonitorLabels`.
- Crossplane v2 watches composed resources. CNPG updates `Cluster.status` often, so the XR can briefly
  report `Responsive=False (WatchCircuitOpen)`. This is Crossplane rate-limiting itself and is harmless.
- Deleting a PostgresCluster deletes the CNPG Cluster **and its PVCs**. Backups in the object store
  are kept. Protect important databases with RBAC (only `edit` can delete) or a Crossplane `Usage`.
