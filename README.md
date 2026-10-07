# CNPG platform

A self-service PostgreSQL platform on Kubernetes, in three layers:

| Folder | What | Built with |
|---|---|---|
| [`01-operator/`](01-operator/) | CloudNativePG operator, Barman Cloud backup plugin and the PostgreSQL image catalog, installed from charts **vendored in this repo** | Helm |
| [`02-crossplane-api/`](02-crossplane-api/) | `PostgresCluster` (`cnpg.cncp.nl/v1alpha1`): one namespaced API object that bundles everything a production CNPG cluster needs, including metrics, alerts and the CNPG Grafana dashboard | Crossplane v2 |
| [`03-backstage-portal/`](03-backstage-portal/) | Portal to create, list and inspect every PostgresCluster; catalog integration and a Software Template | Backstage (new frontend + backend system) |

```
 Backstage portal ──(PostgresCluster)──▶ Crossplane v2 composition ──▶ CNPG Cluster, Pooler, ObjectStore,
   03-backstage-portal                     02-crossplane-api               ScheduledBackup, Database,
                                                                           PodMonitor, PrometheusRule,
                                                                           GrafanaDashboard
                                                                                  │
                                                                                  ▼
                                                                    CloudNativePG operator (01-operator)
```

## Install

Prerequisites in the target cluster: cert-manager (for the backup plugin), the Prometheus Operator
CRDs (PodMonitor/PrometheusRule), and grafana-operator (GrafanaDashboard). The monitoring objects can
be switched off per cluster if you don't run those.

```sh
01-operator/install.sh                 # CNPG 1.30 + barman-cloud plugin + ClusterImageCatalog
02-crossplane-api/install/install.sh   # Crossplane 2.4 + function + RBAC + XRD + Composition
kubectl apply -f 02-crossplane-api/examples/minimal.yaml
```

The portal: see [`03-backstage-portal/README.md`](03-backstage-portal/README.md).

## Test

| Command | Needs | Covers |
|---|---|---|
| `01-operator/verify.sh` | helm | vendored charts lint and render with the production values |
| `make -C 02-crossplane-api test` | crossplane CLI, Docker/podman | composition renders for 3 cases; output validated against the real CRD schemas; status/readiness/dashboard/alert assertions |
| `cd 03-backstage-portal && yarn tsc && yarn test:all` | node 22 | backend (REST API, permissions, catalog provider, scaffolder action) and frontend (form, list page) |
| `hack/e2e-kind.sh` | kind, Docker/podman | full install on a throwaway kind cluster: PostgresCluster goes Ready, `psql` through PgBouncer, metrics scraped, delete cascades |

`hack/e2e-kind.sh` uses its own kubeconfig in `.e2e/` and never touches your current context.
