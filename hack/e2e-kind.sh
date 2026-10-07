#!/usr/bin/env bash
# End-to-end test on a throwaway kind cluster: installs the prerequisites
# (00-deps), 01-operator and 02-crossplane-api exactly as documented, creates
# a Project (namespace + Prometheus + Grafana) and a PostgresCluster in it,
# and checks that the database is healthy, its metrics reach the project's
# Prometheus, its dashboard reaches the project's Grafana, and that the
# Project deletion guardrails hold.
#
# Uses its own kubeconfig file (never touches your current context):
#   hack/e2e-kind.sh                 # create cluster, install, test
#   KEEP=true hack/e2e-kind.sh       # leave the cluster running afterwards
#   export KUBECONFIG=$(pwd)/.e2e/kubeconfig   # then poke around
#
# Rootless podman works: KIND_EXPERIMENTAL_PROVIDER=podman hack/e2e-kind.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLUSTER="${CLUSTER:-cnpg-e2e}"
WORK="${ROOT}/.e2e"
mkdir -p "${WORK}"
export KUBECONFIG="${KUBECONFIG_E2E:-${WORK}/kubeconfig}"

CERT_MANAGER_VERSION="${CERT_MANAGER_VERSION:-v1.21.2}"
KUBE_PROMETHEUS_STACK_VERSION="${KUBE_PROMETHEUS_STACK_VERSION:-89.2.0}"
GRAFANA_OPERATOR_VERSION="${GRAFANA_OPERATOR_VERSION:-5.25.0}"

if ! kind get clusters 2>/dev/null | grep -qx "${CLUSTER}"; then
  echo "==> kind cluster ${CLUSTER}"
  kind create cluster --name "${CLUSTER}" --kubeconfig "${KUBECONFIG}" --wait 180s
fi
kind export kubeconfig --name "${CLUSTER}" --kubeconfig "${KUBECONFIG}" >/dev/null

cleanup() {
  if [[ "${KEEP:-false}" != "true" ]]; then
    kind delete cluster --name "${CLUSTER}" --kubeconfig "${KUBECONFIG}"
  fi
}
trap cleanup EXIT

echo "==> prerequisites (00-deps): cert-manager, Prometheus Operator, grafana-operator"
kubectl apply --server-side -f "https://github.com/cert-manager/cert-manager/releases/download/${CERT_MANAGER_VERSION}/cert-manager.yaml" >/dev/null
# Same flags as 00-deps/README.md: the operator, kube-state-metrics and
# node-exporter, but no Prometheus/Alertmanager/Grafana of its own.
helm upgrade -i prometheus-operator kube-prometheus-stack \
  --repo https://prometheus-community.github.io/helm-charts \
  --version "${KUBE_PROMETHEUS_STACK_VERSION}" -n prometheus-operator-system --create-namespace \
  --set prometheus.enabled=false --set alertmanager.enabled=false --set grafana.enabled=false \
  --wait --timeout 10m >/dev/null
helm upgrade -i grafana-operator grafana-operator \
  --repo https://grafana.github.io/helm-charts \
  --version "${GRAFANA_OPERATOR_VERSION}" -n grafana-operator-system --create-namespace \
  --wait --timeout 5m >/dev/null
kubectl -n cert-manager wait deploy --all --for=condition=Available --timeout=300s

echo "==> 01-operator"
"${ROOT}/01-operator/install.sh"

echo "==> 02-crossplane-api"
"${ROOT}/02-crossplane-api/install/install.sh"

echo "==> Project demo (namespace + Prometheus + Grafana; no ingress on kind)"
kubectl apply -f - <<'PROJECT'
apiVersion: platform.cncp.nl/v1alpha1
kind: Project
metadata:
  name: demo
spec:
  owner: team-demo
  access:
    - group: demo-devs
      role: edit
  observability:
    prometheus:
      retention: 1d
      storage:
        size: 1Gi
      resources:
        requests:
          cpu: 50m
          memory: 256Mi
        limits:
          memory: 1Gi
PROJECT

echo "==> reserved Project names are rejected by the XRD"
if kubectl apply --dry-run=server -f - 2>/dev/null <<'PROJECT'
apiVersion: platform.cncp.nl/v1alpha1
kind: Project
metadata:
  name: kube-evil
PROJECT
then
  echo "FAIL: Project kube-evil was accepted"; exit 1
fi

echo "==> waiting for Project Ready (Prometheus + Grafana pull images)"
if ! kubectl wait project/demo --for=condition=Ready --timeout=600s; then
  kubectl get project demo -o yaml
  kubectl -n demo get prometheus,grafana,grafanadatasource,pods
  exit 1
fi
kubectl get project demo
kubectl get project demo -o jsonpath='{.status}' | python3 -m json.tool
kubectl get namespace demo --show-labels
kubectl -n demo get rolebinding -l platform.cncp.nl/project=demo -o wide

echo "==> PostgresCluster demo/orders-db in the project (1 instance to fit kind)"
kubectl apply -f - <<'PGC'
apiVersion: cnpg.cncp.nl/v1alpha1
kind: PostgresCluster
metadata:
  name: orders-db
  namespace: demo
spec:
  instances: 1
  storage:
    size: 1Gi
  resources:
    requests:
      cpu: 100m
      memory: 256Mi
    limits:
      memory: 512Mi
  pooler:
    enabled: true
    instances: 1
  databases:
    - name: reporting
      owner: app
      extensions: [pg_stat_statements]
PGC

echo "==> waiting for PostgresCluster Ready (pulls the PostgreSQL image; can take a few minutes)"
if ! kubectl -n demo wait postgrescluster/orders-db --for=condition=Ready --timeout=600s; then
  kubectl -n demo get postgrescluster,cluster,pooler,database,podmonitor,prometheusrule,grafanadashboard,pods
  kubectl -n demo get postgrescluster orders-db -o yaml
  exit 1
fi

kubectl -n demo get postgrescluster,cluster,pooler,database,podmonitor,prometheusrule,grafanadashboard,pods
kubectl -n demo get postgrescluster orders-db -o jsonpath='{.status}' | python3 -m json.tool

echo "==> connecting through the pooler with the generated app credentials"
kubectl -n demo exec orders-db-1 -c postgres -- \
  psql "$(kubectl -n demo get secret orders-db-app -o jsonpath='{.data.uri}' | base64 -d | sed 's/orders-db-rw/orders-db-pooler-rw/')" \
  -c 'select version();'

echo "==> metrics endpoint"
kubectl get --raw /api/v1/namespaces/demo/pods/orders-db-1:9187/proxy/metrics | grep -m3 '^cnpg_collector_up'

echo "==> the project's Prometheus scrapes the database"
# cnpg_collector_up{cluster="orders-db"}, URL-encoded.
query='cnpg_collector_up%7Bcluster%3D%22orders-db%22%7D'
prom_query() {
  kubectl get --raw "/api/v1/namespaces/demo/services/prometheus-operated:9090/proxy/api/v1/query?query=$1"
}
for i in $(seq 1 30); do
  if prom_query "${query}" | grep -q '"value"'; then break; fi
  if [[ "${i}" -eq 30 ]]; then
    echo "FAIL: cnpg_collector_up not in the project's Prometheus"; prom_query up; exit 1
  fi
  sleep 10
done
prom_query "${query}"; echo

echo "==> the project's Grafana has the datasource and the cluster's dashboard"
uid="$(kubectl -n demo get postgrescluster orders-db -o jsonpath='{.status.monitoring.dashboardUid}')"
grafana() {
  kubectl get --raw "/api/v1/namespaces/demo/services/grafana-service:3000/proxy/api/$1"
}
for i in $(seq 1 30); do
  if grafana "dashboards/uid/${uid}" 2>/dev/null | grep -q "\"uid\":\"${uid}\""; then break; fi
  if [[ "${i}" -eq 30 ]]; then
    echo "FAIL: dashboard ${uid} not in the project's Grafana"; kubectl -n demo get grafanadashboard -o yaml; exit 1
  fi
  sleep 10
done
grafana datasources/name/prometheus | grep -q '"isDefault":true'
echo "dashboard ${uid} and datasource prometheus present"

echo "==> guardrails: a protected Project and its namespace can't be deleted"
if kubectl delete project demo --wait=false 2>/dev/null; then
  echo "FAIL: protected Project was deleted"; exit 1
fi
if out="$(kubectl delete namespace demo --wait=false 2>&1)"; then
  echo "FAIL: project namespace was deleted directly"; exit 1
fi
grep -q 'delete the Project instead' <<<"${out}"
kubectl get project demo >/dev/null

echo "==> deleting the PostgresCluster cascades to every composed object"
kubectl -n demo delete postgrescluster orders-db --wait --timeout=180s
kubectl -n demo get cluster,pooler,podmonitor,prometheusrule,grafanadashboard 2>&1 | grep -q "No resources found"

echo "==> deleting the Project after turning off deletion protection removes its namespace"
kubectl patch project demo --type merge -p '{"spec":{"deletionProtection":false}}'
kubectl delete project demo --wait --timeout=300s
for i in $(seq 1 30); do
  kubectl get namespace demo >/dev/null 2>&1 || break
  if [[ "${i}" -eq 30 ]]; then
    echo "FAIL: namespace demo still exists"; kubectl get namespace demo -o yaml; exit 1
  fi
  sleep 10
done
if kubectl get clusterrolebinding platform:project:demo:prometheus >/dev/null 2>&1; then
  echo "FAIL: the project's ClusterRoleBinding was left behind"; exit 1
fi

echo "E2E PASSED"
