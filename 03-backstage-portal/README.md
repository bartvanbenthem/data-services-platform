# 03-backstage-portal: CNPG portal

A Backstage app (1.55, new frontend system) for deploying and viewing every `PostgresCluster` from
[`02-crossplane-api`](../02-crossplane-api). It is a CNPG-only portal in KPN style: a dark theme, the
KPN logo, and a fixed sidebar with just PostgreSQL, New cluster and Dashboards.

| Feature | Where |
|---|---|
| **PostgreSQL** page (the landing page): summary tiles, then all clusters across namespaces with health, version, instances, primary, pooler/backup flags; filter + search; auto-refresh | `plugins/cnpg` (`/cnpg`) |
| Cluster detail: status, connection endpoints & credential Secret, storage/HA/pooler/backup/monitoring config, instance pods with roles, conditions, recent events, delete (type-to-confirm) | `/cnpg/:namespace/:name` |
| **Monitoring** tab: the cluster's CNPG Grafana dashboard (the `GrafanaDashboard` the composition creates), embedded with a time-range picker and an "Open in Grafana" link | `/cnpg/:namespace/:name/monitoring` |
| **Dashboards** page: every cluster's dashboard, pick a cluster and it is embedded | `/cnpg/dashboards` |
| Create form with live manifest preview and **Validate** (server-side dry run against the XRD) | `/cnpg/create` |
| Every PostgresCluster in the catalog as a `Resource` (type `postgres-cluster`), with owner/system from the `backstage.io/owner` / `backstage.io/system` labels and a **PostgreSQL** tab | `plugins/cnpg-backend` catalog module |
| Software Template *PostgreSQL cluster (CloudNativePG)* (action `cnpg:postgrescluster:create`) | `templates/postgres-cluster/` |
| Permissions `cnpg.cluster.{read,create,update,delete}`; the UI hides create/delete when denied | `plugins/cnpg-common` |

```
plugins/cnpg            frontend plugin (pages, entity tab, API client)
plugins/cnpg-backend    REST API /api/cnpg, catalog entity provider, scaffolder action
plugins/cnpg-common     shared types + permissions
templates/              Software Template
deploy/                 in-cluster manifests: RBAC, Backstage's own DB (as a PostgresCluster!), Deployment
```

The backend writes **only** `PostgresCluster` objects, using server-side apply with field manager
`backstage-cnpg`. Validation stays in one place, the XRD: API server errors such as
"synchronousReplicas must be lower than instances" are shown in the form as-is.

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

```sh
CNPG_GRAFANA_URL=https://grafana.example.com yarn start
```

- `{namespace}` in the URL is replaced by the cluster's namespace, for one Grafana per namespace
  (the composition's default `instanceSelector` is `dashboards.paas.cncp.nl/scope: <namespace>`).
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

`deploy/rbac.yaml` gives the ServiceAccount full access to `postgresclusters`, read access to CNPG
`clusters`, pods, events and namespaces, and **no** access to Secrets. Backstage's own database is a
PostgresCluster (`deploy/database.yaml`). Plugins share it per schema (`pluginDivisionMode: schema`),
because the CNPG app role can't create databases.

Before production: replace the guest auth provider with your IdP
(<https://backstage.io/docs/auth/>), and replace the allow-all permission policy with one that
restricts `cnpg.cluster.create`/`delete`.
