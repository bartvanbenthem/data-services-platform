#!/usr/bin/env bash
# End-to-end test on a throwaway kind cluster: installs the prerequisites,
# 01-operator and 02-crossplane-api exactly as documented, creates a
# PostgresCluster and waits until Crossplane reports it Ready with a healthy
# CNPG Cluster behind it.
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
PROM_OPERATOR_VERSION="${PROM_OPERATOR_VERSION:-v0.94.1}"
GRAFANA_OPERATOR_VERSION="${GRAFANA_OPERATOR_VERSION:-v5.25.0}"

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

echo "==> prerequisites: cert-manager, Prometheus Operator CRDs, grafana-operator CRDs"
kubectl apply --server-side -f "https://github.com/cert-manager/cert-manager/releases/download/${CERT_MANAGER_VERSION}/cert-manager.yaml" >/dev/null
for crd in podmonitors prometheusrules servicemonitors; do
  kubectl apply --server-side -f "https://raw.githubusercontent.com/prometheus-operator/prometheus-operator/${PROM_OPERATOR_VERSION}/example/prometheus-operator-crd/monitoring.coreos.com_${crd}.yaml" >/dev/null
done
kubectl apply --server-side -f "https://raw.githubusercontent.com/grafana/grafana-operator/${GRAFANA_OPERATOR_VERSION}/config/crd/bases/grafana.integreatly.org_grafanadashboards.yaml" >/dev/null
kubectl -n cert-manager wait deploy --all --for=condition=Available --timeout=300s

echo "==> 01-operator"
"${ROOT}/01-operator/install.sh"

echo "==> 02-crossplane-api"
"${ROOT}/02-crossplane-api/install/install.sh"

echo "==> PostgresCluster demo/orders-db (1 instance to fit kind)"
kubectl create namespace demo --dry-run=client -o yaml | kubectl apply -f -
cat <<'EOF' | kubectl apply -f -
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
EOF

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

echo "==> deleting the PostgresCluster cascades to every composed object"
kubectl -n demo delete postgrescluster orders-db --wait --timeout=180s
kubectl -n demo get cluster,pooler,podmonitor,prometheusrule,grafanadashboard 2>&1 | grep -q "No resources found"

echo "E2E PASSED"
