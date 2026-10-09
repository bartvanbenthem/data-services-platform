# PostgreSQL Platform as a Service

A complete PostgreSQL Platform as a Service on Kubernetes, built on
[CloudNativePG](https://cloudnative-pg.io/) (CNPG). Teams order production-ready PostgreSQL
clusters themselves, through a Kubernetes API or a developer portal. The platform runs and operates
them:

- **Self-service:** one `PostgresCluster` API object, or a form in the Backstage portal, gives a
  team a highly available cluster with connection pooling (PgBouncer), in a size (SKU) from the
  platform's catalog (XS to XL) with PostgreSQL tuned to it, or with custom CPU and memory (see
  [Sizes](crossplane-api/README.md#sizes)).
- **Multi-tenant:** each team works in its own **Project**, with access control, an optional quota
  and deletion protection.
- **Built-in observability:** metrics, alerts and the CNPG Grafana dashboard for every cluster, in
  the Project's own Prometheus and Grafana.
- **Backups and resilience:** continuous backups to object storage, point-in-time restore into a
  new cluster, plus multi-region replicas and disaster recovery (see
  [below](#multi-region-replicas-and-disaster-recovery)).
- **Multi-cluster:** databases run in any number of Kubernetes clusters (**locations**), all
  managed from one control plane.


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
- **Restore:** `spec.restore` creates a new `PostgresCluster` from another cluster's backup folder,
  up to a point in time or the latest state, also of a cluster deleted since (the Project keeps an
  inventory of the folders in its bucket). The source is only read; the restored cluster archives to
  a folder of its own. The portal offers it on a cluster's Backups tab and on the project page.
  See [Restore](crossplane-api/README.md#postgrescluster-restore).

See [Locations](crossplane-api/README.md#locations) for how to configure this.

| Folder | What | Built with |
|---|---|---|
| [`deps/`](deps/) | cert-manager, Prometheus Operator, grafana-operator, ingress; the `demo` Project | Helm, kubectl |
| [`operator/`](operator/) | CloudNativePG operator, Barman Cloud backup plugin and the PostgreSQL image catalog, installed from charts **vendored in this repo** | Helm |
| [`crossplane-api/`](crossplane-api/) | `PostgresCluster` (`cnpg.cncp.nl/v1alpha1`): one namespaced API object that bundles everything a production CNPG cluster needs, including metrics, alerts and the CNPG Grafana dashboard. `Project` (`platform.cncp.nl/v1alpha1`): a namespace with its own Prometheus and Grafana, RoleBindings, an optional quota and deletion protection. Both place what runs in the locations through provider-kubernetes | Crossplane v2 |
| [`backstage-portal/`](backstage-portal/) | Portal to create projects and clusters and to inspect them; catalog integration and Software Templates | Backstage (new frontend + backend system) |

## Install

**Every location** (where databases run): cert-manager (for the backup plugin) and the Prometheus
Operator from [`deps/`](deps/README.md), then CloudNativePG:

```sh
KUBECONFIG=dc-a.kubeconfig operator/install.sh   # CNPG 1.30 + barman-cloud plugin + ClusterImageCatalog
```

**The control plane**: the Prometheus Operator and grafana-operator from
[`deps/`](deps/README.md) (each Project's Grafana and the Prometheus its locations write to
run here; switch them off per project if you don't want them), then:

```sh
crossplane-api/install/install.sh                        # Crossplane 2.4 + function + provider + RBAC + APIs + policies
crossplane-api/install/add-location.sh dc-a dc-a.kubeconfig   # each location (or add it in the portal)
kubectl apply -f deps/control-plane/project-defaults.yaml   # platform-wide Project settings (edit the ingress domain)
kubectl apply -f deps/demo/project.yaml                  # Project demo (edit its location)
kubectl apply -f crossplane-api/examples/minimal.yaml    # a PostgresCluster in demo, running in dc-a
```

See [Locations](crossplane-api/README.md#locations) for the protected and recovery sites and
geo replication. The portal also runs on the control plane: see
[`backstage-portal/README.md`](backstage-portal/README.md).

## Test

| Command | Needs | Covers |
|---|---|---|
| `operator/verify.sh` | helm | vendored charts lint and render with the production values |
| `make -C crossplane-api test` | crossplane CLI, Docker/podman | every composition renders (PostgresCluster: 20 cases incl. sizes from the catalog, geo-replicated, switchover, failover, draining, pinned sites, no Project, the Project's COSI backup bucket, restores from the bucket and from a store of its own; Project: 6 incl. both sites, a COSI bucket with its inventory of backup folders and an unregistered location; Location: 3; empty and observed); output, and the manifests inside provider-kubernetes Objects, validated against the real CRD schemas; status/readiness/dashboard/alert/project-wiring/topology assertions |
| `cd backstage-portal && yarn tsc && yarn test:all` | node 22 | backend (REST API, permissions, catalog provider, scaffolder action) and frontend (form, list page) |
| `hack/e2e-kind.sh` | kind, helm, Docker/podman, `fs.inotify.max_user_instances` ≥ 512 | a control plane and one location on kind, installed as documented: Project goes Ready in both, a PostgresCluster in it goes Ready in the location (no CNPG on the control plane), `psql` through PgBouncer, the location's Prometheus scrapes it and remote-writes to the project's Prometheus on the control plane, its Grafana has the dashboard, deletion guardrails hold, deletes cascade |
| `hack/e2e-locations.sh` | kind, helm, Docker/podman, `fs.inotify.max_user_instances` ≥ 512 | a control plane, a protected and a recovery location, MinIO as the shared object store: a Project with both sites, a geo-replicated PostgresCluster, a row written in the protected site shows up in the recovery site, a point-in-time restore into a new cluster stops at the target time and archives to a folder of its own, a switchover promotes it (writes work, the old primary follows), turning geo replication off switches back first and loses nothing, the policy and XRD rules reject what they should |

Both e2e scripts use their own kubeconfigs in `.e2e/` and never touch your current context.
