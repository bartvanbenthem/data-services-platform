# PostgreSQL Platform as a Service

A complete PostgreSQL Platform as a Service on Kubernetes, built on
[CloudNativePG](https://cloudnative-pg.io/) (CNPG). Teams order production-ready PostgreSQL
clusters themselves, through a Kubernetes API or a developer portal. The platform runs and operates
them:

- **Self-service:** one `PostgresCluster` API object, or a form in the Backstage portal, gives a
  team a highly available cluster with connection pooling (PgBouncer).
- **Multi-tenant:** each team works in its own **Project**, with access control, an optional quota
  and deletion protection.
- **Built-in observability:** metrics, alerts and the CNPG Grafana dashboard for every cluster, in
  the Project's own Prometheus and Grafana.
- **Backups and resilience:** continuous backups to object storage, plus multi-region replicas and
  disaster recovery (see [below](#multi-region-replicas-and-disaster-recovery)).
- **Multi-cluster:** databases run in any number of Kubernetes clusters (**locations**), all
  managed from one control plane.

> **Scope.** For now the platform offers one data service: **PostgreSQL with CNPG**. Other engines
> (caches, message queues, document stores, ...) are out of scope. The layered design (control
> plane, locations, Projects) leaves room for them later, but nothing here is built or tested for
> them.

## Architecture


The platform has three layers. A **control plane** cluster runs the APIs (Crossplane) and the portal
(Backstage), but no databases. The PostgreSQL clusters run in **locations**, which are other
Kubernetes clusters registered with the platform. Teams get a **Project** (a namespace with its own
Prometheus and Grafana) with a **protected** location, where its PostgreSQL clusters run, and
optionally a **recovery** location. With geo replication, a cluster keeps a CNPG replica cluster in
the recovery location, ready to take over. The replica is fed through the project's backup bucket,
which is provisioned with COSI on the control plane and has its own keys for each location.

## Multi-region replicas and disaster recovery

- **Multi-region replicas:** the protected and recovery locations can be clusters in different
  regions or data centers. With geo replication on, every PostgreSQL cluster keeps a CNPG replica
  cluster in the recovery location that continuously replays WAL from the project's backup bucket.
- **Disaster recovery:** set `geoReplication.promotion` on a `PostgresCluster` to move the primary
  to the other location. `Switchover` (the default) is for planned moves: it promotes the replica
  without losing data, and the old primary then follows it as a replica. `Failover` promotes the
  recovery location right away, for when the protected location is down. Turning geo replication
  off switches back to the protected location first, so no writes are lost.
- **Backups:** continuous backups and WAL archiving to the project's object storage bucket with the
  Barman Cloud plugin. The recovery location's replica is fed from this bucket.

See [Locations](02-crossplane-api/README.md#locations) for how to configure this.

| Folder | What | Built with |
|---|---|---|
| [`00-deps/`](00-deps/) | cert-manager, Prometheus Operator, grafana-operator, ingress; the `demo` Project | Helm, kubectl |
| [`01-operator/`](01-operator/) | CloudNativePG operator, Barman Cloud backup plugin and the PostgreSQL image catalog, installed from charts **vendored in this repo** | Helm |
| [`02-crossplane-api/`](02-crossplane-api/) | `PostgresCluster` (`cnpg.cncp.nl/v1alpha1`): one namespaced API object that bundles everything a production CNPG cluster needs, including metrics, alerts and the CNPG Grafana dashboard. `Project` (`platform.cncp.nl/v1alpha1`): a namespace with its own Prometheus and Grafana, RoleBindings, an optional quota and deletion protection. Both place what runs in the locations through provider-kubernetes | Crossplane v2 |
| [`03-backstage-portal/`](03-backstage-portal/) | Portal to create projects and clusters and to inspect them; catalog integration and Software Templates | Backstage (new frontend + backend system) |

## Install

**Every location** (where databases run): cert-manager (for the backup plugin) and the Prometheus
Operator from [`00-deps/`](00-deps/README.md), then CloudNativePG:

```sh
KUBECONFIG=dc-a.kubeconfig 01-operator/install.sh   # CNPG 1.30 + barman-cloud plugin + ClusterImageCatalog
```

**The control plane**: the Prometheus Operator and grafana-operator from
[`00-deps/`](00-deps/README.md) (each Project's Grafana and the Prometheus its locations write to
run here; switch them off per project if you don't want them), then:

```sh
02-crossplane-api/install/install.sh                        # Crossplane 2.4 + function + provider + RBAC + APIs + policies
02-crossplane-api/install/add-location.sh dc-a dc-a.kubeconfig   # each location (or add it in the portal)
kubectl apply -f 00-deps/demo/                              # project-defaults EnvironmentConfig + Project demo (edit its location)
kubectl apply -f 02-crossplane-api/examples/minimal.yaml    # a PostgresCluster in demo, running in dc-a
```

See [Locations](02-crossplane-api/README.md#locations) for the protected and recovery sites and
geo replication. The portal also runs on the control plane: see
[`03-backstage-portal/README.md`](03-backstage-portal/README.md).

## Test

| Command | Needs | Covers |
|---|---|---|
| `01-operator/verify.sh` | helm | vendored charts lint and render with the production values |
| `make -C 02-crossplane-api test` | crossplane CLI, Docker/podman | every composition renders (PostgresCluster: 13 cases incl. geo-replicated, switchover, failover, draining, pinned sites, no Project, the Project's COSI backup bucket; Project: 6 incl. both sites, a COSI bucket and an unregistered location; Location: 3; empty and observed); output, and the manifests inside provider-kubernetes Objects, validated against the real CRD schemas; status/readiness/dashboard/alert/project-wiring/topology assertions |
| `cd 03-backstage-portal && yarn tsc && yarn test:all` | node 22 | backend (REST API, permissions, catalog provider, scaffolder action) and frontend (form, list page) |
| `hack/e2e-kind.sh` | kind, helm, Docker/podman, `fs.inotify.max_user_instances` ≥ 512 | a control plane and one location on kind, installed as documented: Project goes Ready in both, a PostgresCluster in it goes Ready in the location (no CNPG on the control plane), `psql` through PgBouncer, the location's Prometheus scrapes it and remote-writes to the project's Prometheus on the control plane, its Grafana has the dashboard, deletion guardrails hold, deletes cascade |
| `hack/e2e-locations.sh` | kind, helm, Docker/podman, `fs.inotify.max_user_instances` ≥ 512 | a control plane, a protected and a recovery location, MinIO as the shared object store: a Project with both sites, a geo-replicated PostgresCluster, a row written in the protected site shows up in the recovery site, a switchover promotes it (writes work, the old primary follows), turning geo replication off switches back first and loses nothing, the policy and XRD rules reject what they should |

Both e2e scripts use their own kubeconfigs in `.e2e/` and never touch your current context.
