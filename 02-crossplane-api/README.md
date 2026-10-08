# 02-crossplane-api: the `PostgresCluster` and `Project` APIs

Two Crossplane **v2** composite resources:

- `cnpg.cncp.nl/v1alpha1 PostgresCluster` (namespaced) turns ~10 lines of YAML into a production
  CloudNativePG setup.
- `platform.cncp.nl/v1alpha1 Project` (cluster-scoped) is a namespace pre-staged with its own
  Prometheus and Grafana, so every PostgresCluster created in it gets metrics, alerts and a dashboard
  without further setup. See [The Project API](#the-project-api).

The APIs run on a **control plane**: a Kubernetes cluster with Crossplane (and the portal) that
runs no databases itself. The databases run in **locations**, other Kubernetes clusters
registered with the platform. A Project has a **protected** location, where its databases run,
and optionally a **recovery** location. A PostgresCluster with `geoReplication` keeps a
CloudNativePG replica cluster there, ready to take over. See [Locations](#locations).

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

It runs in its Project's protected location. See [`examples/production.yaml`](examples/production.yaml) for every option, and
[`apis/postgrescluster/definition.yaml`](apis/postgrescluster/definition.yaml) for the schema
(defaults, enums and CEL rules, all enforced by the API server).

## What gets composed

Everything but the dashboard goes to the Project's protected location (and, with
`geoReplication`, the same set to its recovery location), each object wrapped in a
provider-kubernetes `Object` on the control plane. The dashboard goes to the project's Grafana on
the control plane.

| Composed resource | When | Notes |
|---|---|---|
| `postgresql.cnpg.io/v1 Cluster` | always | Image from the `ClusterImageCatalog` by major version; pod anti-affinity, zone spread, quorum sync replication, managed roles, optional WAL volume and external LoadBalancer. `inheritedMetadata` puts `cnpg.cncp.nl/postgrescluster` and `backstage.io/kubernetes-id` on every pod/PVC/Service. |
| `barmancloud.cnpg.io/v1 ObjectStore` + `ScheduledBackup` | `backup.enabled` | Barman Cloud **plugin**, replacing the deprecated in-tree `barmanObjectStore`. WAL archiving, an immediate first base backup, then on schedule, with retention. |
| `postgresql.cnpg.io/v1 Database` (per entry) | `databases[]` | Declarative extra databases and extensions |
| `postgresql.cnpg.io/v1 Pooler` (rw, optionally ro) | `pooler.enabled` | PgBouncer with anti-affinity |
| `monitoring.coreos.com/v1 PodMonitor` (instances, poolers) | `monitoring.enabled` (default) | Exposes the Prometheus metrics: the CNPG exporter on `:9187`, PgBouncer on `:9127`. Replaces the deprecated `Cluster.spec.monitoring.enablePodMonitor`. |
| `monitoring.coreos.com/v1 PrometheusRule` | `monitoring.prometheusRule.enabled` (default) | The 19 upstream CNPG alerts, scoped to this cluster; `excludeRules` drops some |
| `v1 Secret` copies | `backup.s3Credentials`, `backup.endpointCA`, `roles[].passwordSecret` | The Secrets the cluster references, copied from the project namespace on the control plane by provider-kubernetes `references`: the values never appear in an `Object` spec |
| `grafana.integreatly.org/v1beta1 GrafanaDashboard` (control plane) | `monitoring.grafanaDashboard.enabled` (default) | **The same CloudNativePG dashboard** as `cn-paas-operator-poc`, with a per-cluster uid/title and the namespace/cluster variables preselected |

The XR's `status` mirrors CNPG (read back through each `Object`'s `status.atProvider.manifest`): phase, ready/total instances, current primary, image, endpoints
(`-rw`/`-ro`/`-r`/pooler), credential Secret names, last backup and recovery window, and the dashboard
uid. A `PostgresReady` condition sits next to Crossplane's own `Ready`/`Synced`.

**Changing a live cluster**: everything except `postgresVersion` (forward only, a major upgrade),
`database` and the storage classes can change in place. The XRD lets volumes (`storage`, `walStorage`)
grow but not shrink, keeps their `storageClass` fixed, and doesn't let `walStorage` be removed. CNPG grows
PVCs online when the StorageClass has `allowVolumeExpansion`; CPU/memory changes restart the instances one
by one, the primary last (switchover).

## Differences from `cp-controlplane-poc` (v1 style)

- `apiextensions.crossplane.io/v2` XRD with `scope: Namespaced`: no claim/XR pair, users create the
  XR directly in their namespace.
- The control plane runs no databases. CNPG and Prometheus Operator objects go to the locations as
  provider-kubernetes `Object`s; only the `GrafanaDashboard` and the Project's own objects are
  composed directly. RBAC is a ClusterRole for exactly those kinds, aggregated into Crossplane's
  own ServiceAccount ([`install/rbac.yaml`](install/rbac.yaml)), instead of `*/*`.
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
  locations:
    protected: dc-a          # where its databases run
    recovery: dc-b           # optional: replica clusters
```

See [`examples/project.yaml`](examples/project.yaml) for access, quota and observability settings, and
[`apis/project/definition.yaml`](apis/project/definition.yaml) for the schema.

On the control plane:

| Composed resource | When | Notes |
|---|---|---|
| `Namespace <name>` | always | Where the PostgresCluster XRs (and the Secrets they reference) live. Labels `platform.cncp.nl/project` and `dashboards.paas.cncp.nl/scope` = `<name>` (the latter is what every PostgresCluster's `GrafanaDashboard` selects by default), `backstage.io/owner`, Pod Security `baseline`. Annotations `platform.cncp.nl/protected-location` / `recovery-location` for the admission policy |
| `ServiceAccount` + `Prometheus` + `PersistentVolumeClaim` | `observability.prometheus.enabled` (default) | Scrapes nothing: receives the samples of the project's locations (remote write). The PVC is named as the StatefulSet names it, so a larger `storage.size` grows the volume |
| `Grafana` + `GrafanaDatasource prometheus` | `observability.grafana.enabled` (default) | Anonymous Viewer, embedding allowed (for the portal), ingress from the EnvironmentConfig. The URL ends up in `status.grafana.url` |
| `Ingress prometheus-remote-write` | `prometheus.remoteWrite` in project-defaults | Only `/api/v1/write`, for the locations' Prometheus |
| `RoleBinding` per `access[]` entry | `access` | Binds a Kubernetes group to the built-in `admin`/`edit`/`view` role: who may manage PostgresClusters |
| `ClusterUsage` per location | registered Location | The Location can't be deleted while the Project uses it |

In the protected and the recovery location (provider-kubernetes `Object`s):

| Composed resource | When | Notes |
|---|---|---|
| `Namespace <name>` | always | Same labels; never deleted by Crossplane |
| `ServiceAccount` + `Prometheus` + `PersistentVolumeClaim` + `ClusterRoleBinding platform:project:<name>:prometheus` | `observability.prometheus.enabled` (default) | Scrapes every `PodMonitor`/`PrometheusRule` in the namespace plus kube-prometheus-stack's node/container ServiceMonitors, evaluates the alerts, labels its series `location`/`site` and sends them to the control plane. The binding points at `cnpg-platform:project-prometheus`, which the Location creates there |
| `RoleBinding` per `access[]` entry | `access` | So the team can see what runs there |
| `ResourceQuota` + `LimitRange` | `quota` | The LimitRange gives default requests so operator-generated pods pass the quota |

Namespaced objects are only rendered once the Namespace is observed, so the first reconcile doesn't
fail. The XR is `Ready` when the namespace is Active, Prometheus is `Available` and Grafana reports
`complete/success`. `ObservabilityReady` carries the message.

**Cluster-wide settings** (the Grafana ingress host, where kube-prometheus-stack runs) come from the
`EnvironmentConfig` named `project-defaults`, requested through function-go-templating's
`ExtraResources`, so no second function is needed. Every key is optional; see
[`examples/project-defaults.yaml`](examples/project-defaults.yaml).

**Resizing**: `observability.prometheus.storage.size` can grow (the PVC grows online if its
StorageClass allows expansion) but not shrink, and its `storageClass` is fixed after creation.

**Names**: the Project name is the namespace name. The XRD's CEL rules allow DNS labels up to 40
characters, without `--` (the portal names catalog entities `<namespace>--<cluster>`), and not `kube-*`,
`default`, `projects` or other system namespaces.

### Guardrails ([`apis/project/policies.yaml`](apis/project/policies.yaml))

Deleting a Project deletes its namespace, and with it every PostgresCluster and its volumes. Two
ValidatingAdmissionPolicies (Kubernetes 1.30+) make that explicit:

- A Project with `spec.deletionProtection: true` (the default) can't be deleted. Set it to `false` first.
  The portal does that itself when you delete a project, but only one without PostgresClusters.
- A project namespace (label `platform.cncp.nl/project`) can only be deleted by Crossplane or the
  garbage collector, so `kubectl delete ns` doesn't bypass the first rule.

A third policy keeps databases off the control plane: a new PostgresCluster needs a namespace
whose Project has a protected location, and turning on `geoReplication` needs a recovery
location. See [Locations](#locations).

### RBAC

Crossplane gets exactly what the compositions compose on the control plane
([`install/rbac.yaml`](install/rbac.yaml)): namespaces, ServiceAccounts, PersistentVolumeClaims,
RoleBindings, Prometheuses, Grafanas, GrafanaDatasources, GrafanaDashboards, Ingresses (the
remote-write endpoint), ClusterUsages and ClusterProviderConfigs. To create bindings without
holding the bound permissions itself, it gets `bind` on just `admin`, `edit` and `view`. What goes
to a location is applied there with that location's kubeconfig. Projects are
cluster-scoped, so the namespace roles don't cover creating them: bind
`cnpg-platform:projects:admin` to whoever may create projects.

## Locations

The control plane runs Crossplane, these APIs and the portal, but no databases. The databases run
in **locations**: other Kubernetes clusters registered with the platform. Each Project uses one
location as its **protected site** and optionally another as its **recovery site**.

```sh
KUBECONFIG=dc-a.kubeconfig ../01-operator/install.sh           # in every location: CNPG, Barman Cloud, catalogs
KUBECONFIG=dc-b.kubeconfig ../01-operator/install.sh
install/add-location.sh dc-a dc-a.kubeconfig                    # on the control plane, or: portal > Locations > Add
install/add-location.sh dc-b dc-b.kubeconfig
kubectl get locations -o wide                                    # CONNECTED, READY, what's missing
kubectl apply -f examples/project.yaml                           # spec.locations: {protected: dc-a, recovery: dc-b}
kubectl apply -f examples/replicated.yaml                        # primary in dc-a, replica cluster in dc-b
```

### Location

A location is a **`Location`** (`platform.cncp.nl/v1alpha1`, cluster-scoped,
[`apis/location`](apis/location/definition.yaml)): settings (`displayName`, `environment`,
`provider`, `region`, `owner`, `storageClass`, `schedulable`) and `credentials.secretRef`, a Secret
with its kubeconfig. [`install/add-location.sh`](install/add-location.sh) and the portal write
that Secret to `cnpg-locations` and create the Location. Anything else that can deliver a Secret
works too (External Secrets, Sealed Secrets, a GitOps repo with the Location next to it):

```yaml
apiVersion: platform.cncp.nl/v1alpha1
kind: Location
metadata:
  name: dc-a
spec:
  environment: production
  region: dc-amsterdam-1
  credentials:
    secretRef: {namespace: cnpg-locations, name: dc-a}   # key defaults to kubeconfig
```

The Location's composition creates the provider-kubernetes `ClusterProviderConfig` with the same
name, the `cnpg-platform:project-prometheus` ClusterRole in the location (never deleted by
Crossplane), and two observe-only `Object`s that check whether CloudNativePG and the Prometheus
Operator are installed there. `status.connected`, `status.operators` and `status.message` show what
Crossplane found. The Location is `READY` once it is connected and both operators are there.

Every object for a location is a namespaced `kubernetes.m.crossplane.io` `Object` next to the XR
on the control plane, which the provider applies in that location with that kubeconfig. Its live
state comes back through `status.atProvider.manifest`, and the compositions read it from there.
The location needs [`01-operator`](../01-operator) and the Prometheus Operator CRDs. The
kubeconfig's identity needs cluster-admin or an equivalent role, and must work from inside the
control plane (no exec plugins).

### Project: protected and recovery site

```yaml
spec:
  locations:
    protected: dc-a     # where the databases run; required, fixed after creation
    recovery: dc-b      # optional: replica clusters; can be added later, then fixed
```

Both locations get the namespace, the `access` RoleBindings, the quota and a Prometheus with
`externalLabels: {location: <name>, site: protected|recovery}`. With `prometheus.remoteWrite` in
[`project-defaults`](examples/project-defaults.yaml), that Prometheus sends its samples to the
project's Prometheus on the control plane, through an Ingress that only exposes `/api/v1/write`, so
the project's Grafana shows both sites. Without it the locations keep their metrics and still
evaluate the alerts, but Grafana sees none. Restrict that Ingress with its `annotations`, e.g. an
IP allow-list.

The sites can't change once set (the XRD refuses it): the databases, and the replica clusters
following them, would be stranded. A recovery site can be added to a Project that has none. The
namespace in a location is never deleted by Crossplane (its `Object` has no `Delete` management
policy): deleting the Project leaves it and anything still running in it.

The Project composition reads the Location of both sites:

- A site without a Location makes the Project not ready, with the reason in `status.message`.
  Its objects are still rendered, so re-creating a Location never tears anything down.
- Every registered location gets a `ClusterUsage` (`protection.crossplane.io`). Crossplane's
  webhook then refuses to delete the Location while a Project uses it.
- Locations with `schedulable: false` are recorded in the namespace annotation
  `platform.cncp.nl/unschedulable-locations`. The admission policy then refuses new
  PostgresClusters when the protected location is closed, and newly turning on `geoReplication`
  when the recovery location is. Existing clusters there stay editable. Projects pick up a changed
  Location on their next reconcile (Crossplane's poll interval, 1 minute by default).

### Backup bucket (COSI)

Geo replication runs through the object store: both sites archive to it and the replica cluster
recovers from it. With COSI (Container Object Storage Interface) on the control plane, every
Project gets a bucket for that, and PostgresClusters don't need object storage details or
credentials of their own:

```yaml
# project-defaults (EnvironmentConfig)
data:
  backup:
    cosi:
      driverName: cloudian-cosi-driver    # each Project gets a BucketClass for it
      parameters: {}                      # driver-specific BucketClass parameters
      bucketAccessClassName: backups-keys
```

The Project composition then composes:

| Object | What for |
|---|---|
| `BucketClass project-<name>-backups` (cluster-scoped) | `deletionPolicy: Retain`, so deleting the Project keeps the bucket and its backups. `spec.backup.bucketClassName` uses an existing class instead (make it Retain too) |
| `BucketClaim backups` | The bucket (`spec.backup.bucket: false` opts a Project out) |
| `BucketAccess backups-<location>` | One per site: each location gets keys of its own, so one site's access can be revoked without the other's. COSI writes them to Secret `cosi-backups-<location>` |
| `Secret backup-s3-<location>` | Those keys unpacked from COSI's `BucketInfo` JSON into `ACCESS_KEY_ID`, `ACCESS_SECRET_KEY` and `REGION`, the keys Barman Cloud reads |
| `Secret backup-check-s3` + `CronJob backup-check`, in each location | That location's keys, and every few minutes (`backup.check.schedule`, default `*/5 * * * *`) a write, read-back and delete of `platform-check/<location>` in the bucket, from the project namespace there: the network path and keys WAL archiving and a replica cluster use. Image `backup.check.image` (default `curlimages/curl:8.16.0`; needs `sh` and curl >= 7.75), `backup.check.enabled: false` turns it off |

All but the class live in the project namespace on the control plane, next to the
PostgresClusters that use them. The keys are no secret from the project's own users: each
location's copy has to sit in the project namespace there, next to the CNPG cluster.

`status.backup` on the Project carries the bucket, endpoint, region, the Barman destination
(`s3://<bucket>/barman`) and the credentials Secret per location; the Project is ready once the
bucket is provisioned and every location has its keys. `status.backup.reachability` has, per
location, the outcome of its last check: `Pending`, `Reachable`, `Unreachable` or `Checking`
(a run after a failure), with `lastCheckTime` and `lastSuccessTime`. It is informational: an
unreachable bucket doesn't make the Project unready. The failed job's log in the location says
why; the portal's project page shows it. The namespace annotation
`platform.cncp.nl/backup-bucket` tells the admission policy the Project has one.

A PostgresCluster with `backup.enabled` and no `destinationPath`/`s3Credentials` uses it: each
site's `ObjectStore` points at the bucket and endpoint, with Secret `<cluster>-backup-s3` copied
into that location from `backup-s3-<location>` (provider-kubernetes `references`, so the keys
never appear in an `Object` spec). The cluster pins the bucket in `status.backupStore` on first
use; while it isn't ready yet, the cluster waits. The admission policy refuses clusters that
newly rely on a bucket the Project doesn't have, and the edit form in the portal keeps the store
fixed once a cluster archives (moving the archive would cut off its replica cluster). A cluster
can still bring its own store, as before.

Requirements: the COSI controller and a driver on the control plane, an access class whose driver
hands out S3 keys (the locations use them; a ServiceAccount identity on the control plane would
be of no use there), and the bucket's endpoint reachable from every location. A retained bucket
outlives its Project: remove it in the object store once its backups are no longer needed.

### PostgresCluster: geo replication

| Field | Meaning |
|---|---|
| `geoReplication.enabled` | A CloudNativePG replica cluster in the Project's recovery location. Needs `backup.enabled` (the Project's backup bucket, or a store of its own). |
| `geoReplication.instances` | Its instances (default `instances`). |
| `geoReplication.primarySite` | `protected` (default) or `recovery`: where the primary is. Changing it switches over. |
| `geoReplication.promotion` | `Switchover` (default) or `Failover`, see below. |

A PostgresCluster has no location of its own: the composition reads its Project (an extra resource
named after the namespace) and pins the sites in `status.sites` on first use, so a cluster never
moves. Outside a Project with a protected location nothing is composed but the dashboard, and the
admission policy ([`policies.yaml`](apis/project/policies.yaml)) refuses to create one there anyway.
If the sites can't be determined while objects exist (no `status.sites`, no Project), the
composition fails instead of rendering an empty desired state, so Crossplane leaves the database
alone.

Both sites' Clusters are named after the PostgresCluster, so the `-rw`/`-ro` services and the
`-app` Secret have the same names in both. The poolers, PodMonitors, alert rules, databases and
`expose` service exist in both. The composition also copies the Secrets the cluster references
from the control plane to each site: the S3 credentials (each site's own for the Project's
bucket), the endpoint CA and `roles[].passwordSecret`. It uses provider-kubernetes `references`, which patch `data`/`type` from
the Secret on the control plane, so the values never appear in an `Object` spec.
`--sanitize-secrets` keeps them out of its status as well.

The replica cluster uses CloudNativePG's
[distributed topology](https://cloudnative-pg.io/documentation/current/replica_cluster/). Each
site's Cluster lists both in `externalClusters`. They point at the same Barman Cloud object store,
each with its own server name: `<name>` for the protected site, `<name>-<recovery location>` for
the replica cluster. `replica.primary` names the one that's primary. The replica cluster
bootstraps from the protected site's base backup, then replays its WAL archive, so the sites need
no network path to each other. They only need the bucket. `status.locations[]` shows each site's
location, role and health; `status.primarySite`/`status.primaryLocation` show where the primary is.

Switching the primary (`geoReplication.primarySite: recovery`, and back with `protected`):

- **Switchover** (default): the composition demotes the current primary first. CloudNativePG then
  publishes a demotion token in that Cluster's status, and the composition promotes the other site
  with it (`replica.promotionToken`). It only takes over once it has replayed everything the old
  primary wrote, so no transaction is lost. Until then its role is `promoting` and the message says
  what it waits for. Tokens that already promoted a cluster are never reused.
- **Failover**: promotes the other site right away, for when the primary's location is down.
  Transactions that weren't archived yet are lost. When the old location comes back, its Cluster
  is told to follow the new primary. If its timeline diverged, it may have to be recreated.

Turning `geoReplication` off removes the replica cluster. If the primary is in the recovery site at
that moment, the composition first switches it back to the protected site (a switchover), and
removes the replica cluster after that.

Limitations: the `-app` Secret in the recovery site is generated there, so after a switchover use
the credentials of the protected site (or manage the app role's password with
`roles[].passwordSecret`). The CNPG dashboard doesn't filter on `location`, so a cluster's panels
add up the series of both sites. Applications connect through each site's own services; nothing
routes between sites. A Project's sites can't be moved: to leave a location, create a Project with
other sites and restore the databases there from their backups.

## Layout

```
apis/postgrescluster/definition.yaml       XRD (the API contract)
apis/postgrescluster/composition.tmpl.yaml composition source -- edit this
apis/postgrescluster/composition.yaml      GENERATED (make generate)
src/dashboards/cnpg-cluster.json           CNPG Grafana dashboard (Apache-2.0)
src/alerts/cnpg-cluster-rules.yaml         CNPG alerts from the cnpg/cluster chart (hack/refresh-alerts.sh)
apis/location/definition.yaml              Location XRD (cluster-scoped): another Kubernetes cluster
apis/location/composition.yaml             its ClusterProviderConfig, Prometheus ClusterRole, operator checks
apis/project/definition.yaml               Project XRD (cluster-scoped)
apis/project/composition.yaml              Project composition (hand-written, nothing embedded)
apis/project/policies.yaml                 deletion protection, PostgresClusters only in a Project's
                                           sites, unschedulable locations
hack/generate.py                           embeds src/ into the composition (escapes {{ }})
hack/observe.py                            generates tests/render observed-state fixtures
install/                                   Crossplane, function-go-templating, provider-kubernetes, RBAC,
                                           install/uninstall, add-location.sh, migrate-locations.sh
examples/                                  PostgresClusters (incl. a geo-replicated one), a Project, the
                                           project-defaults EnvironmentConfig
tests/render/<api>/                        offline render + schema validation tests per API
```

## Install

On the control plane (Prometheus Operator and grafana-operator there for each Project's
Prometheus and Grafana; CloudNativePG isn't needed there):

```sh
install/install.sh                        # Crossplane 2.4.2 + everything above
SKIP_CROSSPLANE=true install/install.sh   # Crossplane already installed
install/add-location.sh dc-a dc-a.kubeconfig      # every location: ../01-operator/install.sh there first
kubectl apply -f examples/project-defaults.yaml   # edit the ingress hosts first
kubectl apply -f examples/project.yaml            # edit spec.locations first
kubectl apply -f examples/minimal.yaml
kubectl get project,postgrescluster -A
```

The Composition is applied with `--server-side`, because the embedded dashboard exceeds the
client-side `last-applied-configuration` annotation limit.

## Connect from outside the cluster

The database runs in the Project's protected location, so connect there (`kubectl` against that
cluster). With `spec.expose` set (as in `examples/minimal.yaml`), the primary is reachable through
the LoadBalancer Service `<name>-external`. Your client IP must be in
`expose.loadBalancerSourceRanges`.

```sh
export KUBECONFIG=dc-a.kubeconfig     # the protected location
LB_IP=$(kubectl -n demo get svc orders-db-external -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
PGPASS=$(kubectl -n demo get secret orders-db-app -o jsonpath='{.data.password}' | base64 -d)

psql "postgresql://app:${PGPASS}@${LB_IP}:5432/app?sslmode=require"
```

The `uri`/`jdbc-uri` keys in the `<name>-app` Secret point at the in-cluster host
`<name>-rw.<namespace>.svc`, so don't use them from outside. After a switchover to the recovery
site, connect to that location instead.

## Develop

```sh
make generate   # after editing composition.tmpl.yaml or src/
make test       # crossplane render for every API (PostgresCluster: 13 cases incl. geo-replicated,
                # switchover/failover/promoted, draining, pinned sites, no Project, the Project's
                # backup bucket and one still provisioning; Project: 6 cases incl. both sites, a
                # COSI bucket and an unregistered location; Location: connected, ready,
                # unreachable; each empty and observed where it matters; required/ mocks the
                # Projects, Locations and EnvironmentConfig), crossplane resource validate against
                # the CNPG/Barman/Prometheus/Grafana/provider-kubernetes/ClusterUsage CRDs
                # (manifests inside Objects too), assertions
python3 hack/observe.py project full   # regenerate an observed-state fixture after changing a composition
# crossplane render doesn't resolve namespaced extra resources (Crossplane itself does), so the
# render tests can't show COSI's credentials Secrets being unpacked; they check the rest.
../hack/e2e-kind.sh        # the real thing: a control plane and one location on kind
../hack/e2e-locations.sh   # control plane, protected and recovery location: replication, switchover
```

## Notes

- Grafana: the default `instanceSelector` is `dashboards.paas.cncp.nl/scope: <namespace>`, which
  matches the GrafanaInstances of the paas platform. Override it with
  `monitoring.grafanaDashboard.instanceSelector`.
- Prometheus: if your Prometheus selects monitors by label (e.g. kube-prometheus-stack's
  `release`), set `monitoring.podMonitorLabels`.
- Crossplane v2 watches composed resources. CNPG updates `Cluster.status` often, so the XR can briefly
  report `Responsive=False (WatchCircuitOpen)`. This is Crossplane rate-limiting itself and is harmless.
- Deleting a PostgresCluster deletes the CNPG Cluster in each site **and its PVCs**. Backups in the object store
  are kept. Protect important databases with RBAC (only `edit` can delete) or a Crossplane `Usage`.
