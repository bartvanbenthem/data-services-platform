# 03-backstage-portal: CNPG portal

A Backstage app (1.55, new frontend system) for deploying and viewing every `PostgresCluster` from
[`02-crossplane-api`](../02-crossplane-api).

| Feature | Where |
|---|---|
| **PostgreSQL** page in the sidebar: all clusters across namespaces with health, version, instances, primary, pooler/backup flags; filter + search; auto-refresh | `plugins/cnpg` (`/cnpg`) |
| Cluster detail: status, connection endpoints & credential Secret, storage/HA/pooler/backup/monitoring config, instance pods with roles, conditions, recent events, Grafana link, delete (type-to-confirm) | `/cnpg/:namespace/:name` |
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

Without `CNPG_KUBE_CONTEXT` the backend uses your **current** kubeconfig context. Set
`CNPG_GRAFANA_URL` to enable dashboard links. Other settings are under `cnpg:` in `app-config.yaml`
(schema: `plugins/cnpg-backend/config.d.ts`).

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
