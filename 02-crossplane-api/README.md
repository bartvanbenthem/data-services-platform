# 02-crossplane-api: the `PostgresCluster` and `Project` APIs

Two Crossplane **v2** composite resources:

- `cnpg.cncp.nl/v1alpha1 PostgresCluster` (namespaced) turns ~10 lines of YAML into a production
  CloudNativePG setup.
- `platform.cncp.nl/v1alpha1 Project` (cluster-scoped) is a namespace pre-staged with its own
  Prometheus and Grafana, so every PostgresCluster created in it gets metrics, alerts and a dashboard
  without further setup. See [The Project API](#the-project-api).

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

## The Project API

```yaml
apiVersion: platform.cncp.nl/v1alpha1
kind: Project
metadata:
  name: team-payments        # = the namespace
spec:
  owner: team-payments       # Backstage group
```

See [`examples/project.yaml`](examples/project.yaml) for access, quota and observability settings, and
[`apis/project/definition.yaml`](apis/project/definition.yaml) for the schema.

| Composed resource | When | Notes |
|---|---|---|
| `Namespace <name>` | always | Labels `platform.cncp.nl/project` and `dashboards.paas.cncp.nl/scope` = `<name>` (the latter is what every PostgresCluster's `GrafanaDashboard` selects by default), `backstage.io/owner`, Pod Security `baseline` |
| `ServiceAccount` + `Prometheus` + `ClusterRoleBinding platform:project:<name>:prometheus` | `observability.prometheus.enabled` (default) | Scrapes every `PodMonitor`/`PrometheusRule` in the namespace plus kube-prometheus-stack's node/container ServiceMonitors. The binding points at one shared ClusterRole, `cnpg-platform:project-prometheus` |
| `Grafana` + `GrafanaDatasource prometheus` | `observability.grafana.enabled` (default) | Anonymous Viewer, embedding allowed (for the portal), ingress from the EnvironmentConfig. The URL ends up in `status.grafana.url` |
| `RoleBinding` per `access[]` entry | `access` | Binds a Kubernetes group to the built-in `admin`/`edit`/`view` role |
| `ResourceQuota` + `LimitRange` | `quota` | The LimitRange gives default requests so operator-generated pods pass the quota |

Namespaced objects are only rendered once the Namespace is observed, so the first reconcile doesn't
fail. The XR is `Ready` when the namespace is Active, Prometheus is `Available` and Grafana reports
`complete/success`. `ObservabilityReady` carries the message.

**Cluster-wide settings** (the Grafana ingress host, where kube-prometheus-stack runs) come from the
`EnvironmentConfig` named `project-defaults`, requested through function-go-templating's
`ExtraResources`, so no second function is needed. Every key is optional; see
[`examples/project-defaults.yaml`](examples/project-defaults.yaml).

**Names**: the Project name is the namespace name. The XRD's CEL rules allow DNS labels up to 40
characters, without `--` (the portal names catalog entities `<namespace>--<cluster>`), and not `kube-*`,
`default`, `projects` or other system namespaces.

### Guardrails ([`apis/project/policies.yaml`](apis/project/policies.yaml))

Deleting a Project deletes its namespace, and with it every PostgresCluster and its volumes. Two
ValidatingAdmissionPolicies (Kubernetes 1.30+) make that explicit:

- A Project with `spec.deletionProtection: true` (the default) can't be deleted. Set it to `false` first.
- A project namespace (label `platform.cncp.nl/project`) can only be deleted by Crossplane or the
  garbage collector, so `kubectl delete ns` doesn't bypass the first rule.

Optional, with `REQUIRE_PROJECT=true install/install.sh`
([`require-project-policy.yaml`](apis/project/require-project-policy.yaml)): new PostgresClusters only
in Project namespaces. Namespaces labelled `platform.cncp.nl/allow-unmanaged-postgres=true` are
exempt (`03-backstage-portal/deploy` sets it on `backstage`, where the portal's own database lives).

### RBAC

Crossplane gets exactly what the Project composition needs ([`install/rbac.yaml`](install/rbac.yaml)):
namespaces, ServiceAccounts, quotas, (Cluster)RoleBindings, Prometheuses, Grafanas and
GrafanaDatasources. To create bindings without holding the bound permissions itself, it gets `bind`
on just four ClusterRoles: `admin`, `edit`, `view` and `cnpg-platform:project-prometheus`. Projects are
cluster-scoped, so the namespace roles don't cover creating them: bind
`cnpg-platform:projects:admin` to whoever may create projects.

## Layout

```
apis/postgrescluster/definition.yaml       XRD (the API contract)
apis/postgrescluster/composition.tmpl.yaml composition source -- edit this
apis/postgrescluster/composition.yaml      GENERATED (make generate)
src/dashboards/cnpg-cluster.json           CNPG Grafana dashboard (Apache-2.0)
src/alerts/cnpg-cluster-rules.yaml         CNPG alerts from the cnpg/cluster chart (hack/refresh-alerts.sh)
apis/project/definition.yaml               Project XRD (cluster-scoped)
apis/project/composition.yaml              Project composition (hand-written, nothing embedded)
apis/project/policies.yaml                 deletion protection (always installed)
apis/project/require-project-policy.yaml   optional: PostgresClusters only in Projects
hack/generate.py                           embeds src/ into the composition (escapes {{ }})
install/                                   Crossplane, function-go-templating, RBAC, install/uninstall
examples/                                  PostgresClusters, a Project, the project-defaults EnvironmentConfig
tests/render/<api>/                        offline render + schema validation tests per API
```

## Install

```sh
install/install.sh                        # Crossplane 2.4.2 + everything above
SKIP_CROSSPLANE=true install/install.sh   # Crossplane already installed
kubectl apply -f examples/project-defaults.yaml   # edit the Grafana host first
kubectl apply -f examples/project.yaml
kubectl apply -f examples/minimal.yaml
kubectl get project,postgrescluster -A
```

The Composition is applied with `--server-side`, because the embedded dashboard exceeds the
client-side `last-applied-configuration` annotation limit.

## Connect from outside the cluster

With `spec.expose` set (as in `examples/minimal.yaml`), the primary is reachable through the
LoadBalancer Service `<name>-external`. Your client IP must be in `expose.loadBalancerSourceRanges`.

```sh
LB_IP=$(kubectl -n demo get svc orders-db-external -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
PGPASS=$(kubectl -n demo get secret orders-db-app -o jsonpath='{.data.password}' | base64 -d)

psql "postgresql://app:${PGPASS}@${LB_IP}:5432/app?sslmode=require"
```

The `uri`/`jdbc-uri` keys in the `<name>-app` Secret point at the in-cluster host
`<name>-rw.<namespace>.svc`, so don't use them from outside.

## Develop

```sh
make generate   # after editing composition.tmpl.yaml or src/
make test       # crossplane render for both APIs (PostgresCluster: 3 cases, Project: 3 cases, each
                # empty and observed; the Project cases mock the EnvironmentConfig), crossplane
                # resource validate against the CNPG/Barman/Prometheus/Grafana CRDs, assertions
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
