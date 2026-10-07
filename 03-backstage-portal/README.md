# 03-backstage-portal: CNPG portal

A Backstage app (1.55, new frontend system) for creating Projects and deploying and viewing every
`PostgresCluster` from [`02-crossplane-api`](../02-crossplane-api). It is a CNPG-only portal in KPN
style: a dark theme, the KPN logo, and a fixed sidebar with Locations, Add location, Projects, New
project, PostgreSQL, New cluster and Dashboards.

| Feature | Where |
|---|---|
| **PostgreSQL** page (the landing page): summary tiles, then all clusters across namespaces with health, version, instances, primary, pooler/backup flags; filter + search; auto-refresh | `plugins/cnpg` (`/cnpg`) |
| Cluster detail: status, connection endpoints & credential Secret, storage/HA/pooler/backup/monitoring config, instance pods with roles, conditions, recent events, **Edit**, delete (type-to-confirm) | `/cnpg/:namespace/:name` |
| **Edit cluster**: everything that changes in place: volume sizes (grow only), instances, CPU/memory, HA, pooler, backups, monitoring, owner. Name, project, PostgreSQL version, database and StorageClass are read-only. The panel shows the exact change (a merge patch); **Validate** dry-runs it | `/cnpg/:namespace/:name/edit` |
| **Locations** page: the Kubernetes clusters the platform can use, with environment, provider/region, API server, Kubernetes version, Ready nodes and health (probed from the backend, cached 30s) | `/cnpg/locations` |
| Location detail: settings, connection (server, context, auth type, TLS), every health check, **Check now**, **Edit**, remove (type-to-confirm) | `/cnpg/locations/:name` |
| **Add location** / **Edit location**: upload or paste a kubeconfig (pick a context if it has several), name, environment, provider, region, owner, default StorageClass, open/closed for new databases; **Test connection** probes it before saving | `/cnpg/locations/create`, `/cnpg/locations/:name/edit` |
| **Logs** tab: stdout of the cluster's pods (pick a pod, tail size, follow, previous container), shown readable or as raw JSON | `/cnpg/:namespace/:name/logs` |
| **Monitoring** tab: the cluster's CNPG Grafana dashboard (the `GrafanaDashboard` the composition creates), embedded with a time-range picker and an "Open in Grafana" link | `/cnpg/:namespace/:name/monitoring` |
| **Dashboards** page: every cluster's dashboard, pick a cluster and it is embedded | `/cnpg/dashboards` |
| **Projects** page: every Project (namespace + Prometheus + Grafana) with health, owner, cluster count and a Grafana link | `/cnpg/projects` |
| Project detail: namespace, owner, access, quota, deletion protection, Grafana/Prometheus endpoints, the clusters in it, **Edit**, **Create cluster here** | `/cnpg/projects/:name` |
| **Edit project**: owner, description, access groups, quota, metrics retention, Prometheus volume size (grow only), Grafana ingress | `/cnpg/projects/:name/edit` |
| Create-project form with manifest preview and **Validate** | `/cnpg/projects/create` |
| Create-cluster form with live manifest preview and **Validate** (server-side dry run against the XRD). The cluster's namespace is picked from the Projects, not typed | `/cnpg/create` |
| Every Project in the catalog as a `Resource` of type `project` (named after the project, owner from `spec.owner`), and every PostgresCluster as a `Resource` of type `postgres-cluster` (owner/system from the `backstage.io/owner` / `backstage.io/system` labels, `dependsOn` its project, a **PostgreSQL** tab) | `plugins/cnpg-backend` catalog module |
| Software Templates *Project* (action `cnpg:project:create`) and *PostgreSQL cluster (CloudNativePG)* (action `cnpg:postgrescluster:create`, project picked with an `EntityPicker` on `spec.type: project`) | `templates/` |
| Permissions `cnpg.cluster.{read,create,update,delete}`, `cnpg.project.{read,create,update}` and `cnpg.location.{read,create,update,delete}`; the UI hides create/edit/delete when denied | `plugins/cnpg-common` |

```
plugins/cnpg            frontend plugin (pages, entity tab, API client)
plugins/cnpg-backend    REST API /api/cnpg, catalog entity provider, scaffolder action
plugins/cnpg-common     shared types + permissions
templates/              Software Templates (project, postgres-cluster)
deploy/                 in-cluster manifests: RBAC, Backstage's own DB (as a PostgresCluster!), Deployment
```

The backend writes **only** `PostgresCluster` and `Project` objects with field manager `backstage-cnpg`
(plus the location Secrets in `cnpg-locations`, see [Locations](#locations)):
server-side apply to create them, a JSON merge patch of just the changed fields to edit them (so settings
made with kubectl stay). Validation stays in one place, the XRD: API server errors such as
"synchronousReplicas must be lower than instances" or "volumes can grow but not shrink" are shown in the
form as-is.

## Run locally

```sh
yarn install
CNPG_KUBE_CONTEXT=$(kubectl config current-context) yarn start   # http://localhost:3000 → Enter as guest
```

Without `CNPG_KUBE_CONTEXT` the backend uses your **current** kubeconfig context. Other settings are
under `cnpg:` in `app-config.yaml` (schema: `plugins/cnpg-backend/config.d.ts`).

### Grafana dashboards

Each PostgresCluster gets a `GrafanaDashboard` (grafana-operator) with a per-cluster uid, which the
XR reports in `status.monitoring.dashboardUid`. The portal embeds `<grafanaUrl>/d/<uid>` in kiosk mode.

For a cluster in a Project, `<grafanaUrl>` is the project's own Grafana (`status.grafana.url`), so
nothing needs configuring. For clusters outside a Project, set a fallback:

```sh
CNPG_GRAFANA_URL=https://grafana.example.com yarn start
```

- `{namespace}` in the fallback URL is replaced by the cluster's namespace, for one Grafana per
  namespace (the composition's default `instanceSelector` is `dashboards.paas.cncp.nl/scope: <namespace>`).
- Grafana must allow embedding and give the browser a session inside the iframe:

  ```yaml
  # Grafana CR (grafana-operator), spec.config
  security:
    allow_embedding: "true"
  auth.anonymous:            # or the same SSO as the portal
    enabled: "true"
    org_role: Viewer
  ```

- `backend.csp.frame-src` in `app-config.yaml` allows the iframe; narrow it to your Grafana host in
  production.
- Without `CNPG_GRAFANA_URL` the Monitoring tab explains how to connect Grafana instead.

### Locations

A location is a Kubernetes cluster the platform can use. Each one is a Secret in the platform cluster's
`cnpg-locations` namespace (`cnpg.locations.namespace`): the kubeconfig under the `kubeconfig` key (the
layout Crossplane's provider-kubernetes and provider-helm read), the settings as JSON in the
`platform.cncp.nl/location-spec` annotation, label `platform.cncp.nl/location=true`. The kubeconfig never
leaves the backend; the API returns only server, context and auth type.

On upload the backend keeps only the chosen context and **rejects** kubeconfigs that would run commands or read
files on the backend (`exec`, `auth-provider`, `token-file`, file paths for certificates) and plain-http
servers. For EKS, GKE or AKS with Entra ID, which use `exec`, create a ServiceAccount with a token instead:

```sh
kubectl -n kube-system create serviceaccount data-services-platform
kubectl create clusterrolebinding data-services-platform \
  --clusterrole=cluster-admin --serviceaccount=kube-system:data-services-platform   # or a narrower role
kubectl -n kube-system create token data-services-platform --duration=8760h        # paste as users[].user.token
```

Health checks, run from the portal backend (so a location must be reachable from where the portal runs):
the API server answers `/version` (else **Unreachable**), `/readyz`, Ready nodes (none Ready means
**Degraded**), and whether CloudNativePG is installed (a warning, not an error). Removing a location only
deletes the Secret; nothing on that cluster changes.

### Look and feel

`packages/app/src/modules/theme` holds the KPN theme (the only theme) and the token overrides for
Backstage UI. `packages/app/src/modules/nav` holds the logo, the sidebar, the app shell and the
sign-in page. `app.packages.include` in `app-config.yaml` loads only the catalog and cnpg frontend
plugins; the other plugins stay in `packages/app/package.json` but are not bundled into the app.

## Test

```sh
yarn tsc
yarn test:all
yarn lint:all
```

## Deploy in the cluster

```sh
yarn install --immutable && yarn tsc && yarn build:backend
docker build -t <registry>/cnpg-portal:<tag> -f packages/backend/Dockerfile .
# set the image in deploy/backstage.yaml, then
kubectl apply -k deploy/
```

`deploy/rbac.yaml` gives the ServiceAccount full access to `postgresclusters`, get/list/create/patch on
`projects` (no delete: removing a project removes its databases, which stays a kubectl decision), read
access to CNPG `clusters`, pods, pod logs, events and namespaces, and access to Secrets **only** in the
`cnpg-locations` namespace (the locations' kubeconfigs). Backstage's own database is a
PostgresCluster (`deploy/database.yaml`). Plugins share it per schema (`pluginDivisionMode: schema`),
because the CNPG app role can't create databases.

Before production: replace the guest auth provider with your IdP
(<https://backstage.io/docs/auth/>), and replace the allow-all permission policy with one that
restricts `cnpg.cluster.create`/`update`/`delete`, `cnpg.project.create`/`update` and
`cnpg.location.create`/`update`/`delete` (a location is a kubeconfig, often cluster-admin: platform admins
only).

The scaffolder *frontend* isn't bundled (`app.packages.include`), so in the portal you create projects
and clusters with its own forms. The Software Templates and actions are registered in the backend, for
the scaffolder API, MCP actions, or a Backstage instance that does include the scaffolder UI.
