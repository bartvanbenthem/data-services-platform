# CNPG platform

A self-service PostgreSQL platform on Kubernetes, in three layers. Teams get a **Project** (a
namespace with its own Prometheus and Grafana) and create PostgreSQL clusters inside it.

| Folder | What | Built with |
|---|---|---|
| [`01-operator/`](01-operator/) | CloudNativePG operator, Barman Cloud backup plugin and the PostgreSQL image catalog, installed from charts **vendored in this repo** | Helm |
| [`00-deps/`](00-deps/) | cert-manager, Prometheus Operator, grafana-operator, ingress; the `demo` Project | Helm, kubectl |
| [`02-crossplane-api/`](02-crossplane-api/) | `PostgresCluster` (`cnpg.cncp.nl/v1alpha1`): one namespaced API object that bundles everything a production CNPG cluster needs, including metrics, alerts and the CNPG Grafana dashboard. `Project` (`platform.cncp.nl/v1alpha1`): a namespace with its own Prometheus and Grafana, RoleBindings, an optional quota and deletion protection | Crossplane v2 |
| [`03-backstage-portal/`](03-backstage-portal/) | Portal to create projects and clusters and to inspect them; catalog integration and Software Templates | Backstage (new frontend + backend system) |

## Install

Prerequisites in the target cluster ([`00-deps/`](00-deps/README.md)): cert-manager (for the backup
plugin), the Prometheus Operator and grafana-operator, which Projects use to run a Prometheus and a
Grafana per namespace. The monitoring objects can be switched off per cluster and per project if you
don't run those.

```sh
01-operator/install.sh                 # CNPG 1.30 + barman-cloud plugin + ClusterImageCatalog
02-crossplane-api/install/install.sh   # Crossplane 2.4 + function + RBAC + both APIs + policies
kubectl apply -f 00-deps/demo/         # project-defaults EnvironmentConfig + Project demo
kubectl apply -f 02-crossplane-api/examples/minimal.yaml   # a PostgresCluster in demo
```

The portal: see [`03-backstage-portal/README.md`](03-backstage-portal/README.md).

## Test

| Command | Needs | Covers |
|---|---|---|
| `01-operator/verify.sh` | helm | vendored charts lint and render with the production values |
| `make -C 02-crossplane-api test` | crossplane CLI, Docker/podman | both compositions render (3 cases each, empty and observed); output validated against the real CRD schemas; status/readiness/dashboard/alert/project-wiring assertions |
| `cd 03-backstage-portal && yarn tsc && yarn test:all` | node 22 | backend (REST API, permissions, catalog provider, scaffolder action) and frontend (form, list page) |
| `hack/e2e-kind.sh` | kind, helm, Docker/podman | full install on a throwaway kind cluster: Project goes Ready, a PostgresCluster in it goes Ready, `psql` through PgBouncer, the project's Prometheus scrapes it and its Grafana has the dashboard, deletion guardrails hold, deletes cascade |

`hack/e2e-kind.sh` uses its own kubeconfig in `.e2e/` and never touches your current context.
