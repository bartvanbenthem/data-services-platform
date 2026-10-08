#!/usr/bin/env bash
# Installs Crossplane v2 core, function-go-templating, provider-kubernetes
# (which places everything in the locations), the RBAC Crossplane needs, and
# the Location, PostgresCluster and Project APIs (XRDs + Compositions +
# admission policies) into the control plane cluster your current kubeconfig
# context points at. Idempotent -- safe to re-run. Register the locations the
# databases run in afterwards with add-location.sh.
#
# The control plane runs no databases, so it doesn't need CloudNativePG.
# It does run each Project's Prometheus (the remote-write receiver) and
# Grafana: install the Prometheus Operator and grafana-operator first
# (../../00-deps), or switch them off per Project. Every location needs
# ../../01-operator/install.sh and the Prometheus Operator.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="${SCRIPT_DIR}/../apis"
CROSSPLANE_NAMESPACE="${CROSSPLANE_NAMESPACE:-crossplane-system}"
CROSSPLANE_VERSION="${CROSSPLANE_VERSION:-2.4.2}"
SKIP_CROSSPLANE="${SKIP_CROSSPLANE:-false}"

if [[ "${SKIP_CROSSPLANE}" != "true" ]]; then
  echo "==> Crossplane ${CROSSPLANE_VERSION} (helm) in ${CROSSPLANE_NAMESPACE}"
  helm repo add crossplane-stable https://charts.crossplane.io/stable >/dev/null 2>&1 || true
  helm repo update crossplane-stable >/dev/null
  helm upgrade --install crossplane crossplane-stable/crossplane \
    --version "${CROSSPLANE_VERSION}" \
    --namespace "${CROSSPLANE_NAMESPACE}" --create-namespace \
    --wait
fi

echo "==> RBAC for composed objects"
kubectl apply -f "${SCRIPT_DIR}/rbac.yaml"

echo "==> function-go-templating"
kubectl apply -f "${SCRIPT_DIR}/functions.yaml"
kubectl wait function.pkg.crossplane.io/function-go-templating --for=condition=Healthy --timeout=300s

echo "==> provider-kubernetes (locations)"
kubectl apply -f "${SCRIPT_DIR}/provider-kubernetes.yaml"
kubectl wait provider.pkg.crossplane.io/provider-kubernetes --for=condition=Healthy --timeout=300s

echo "==> Location XRD + Composition"
kubectl apply -f "${API_DIR}/location/definition.yaml"
kubectl wait xrd/locations.platform.cncp.nl --for=condition=Established --timeout=120s
kubectl apply -f "${API_DIR}/location/composition.yaml"

echo "==> PostgresCluster XRD"
kubectl apply -f "${API_DIR}/postgrescluster/definition.yaml"
kubectl wait xrd/postgresclusters.cnpg.cncp.nl --for=condition=Established --timeout=120s

echo "==> PostgresCluster Composition"
# Server-side apply: the embedded Grafana dashboard (~250 KiB) would not fit
# in kubectl's client-side last-applied-configuration annotation (256 KiB cap).
kubectl apply --server-side --force-conflicts -f "${API_DIR}/postgrescluster/composition.yaml"

echo "==> Project XRD + Composition"
kubectl apply -f "${API_DIR}/project/definition.yaml"
kubectl wait xrd/projects.platform.cncp.nl --for=condition=Established --timeout=120s
kubectl apply -f "${API_DIR}/project/composition.yaml"

echo "==> Project admission policies (deletion protection, locations)"
sed "s/system:serviceaccount:crossplane-system:crossplane'/system:serviceaccount:${CROSSPLANE_NAMESPACE}:crossplane'/" \
  "${API_DIR}/project/policies.yaml" | kubectl apply -f -

EXAMPLES="$(cd "${SCRIPT_DIR}/.." && pwd)/examples"
echo "==> Done. Try:"
echo "      $(dirname "$0")/add-location.sh <name> <kubeconfig>   # each cluster databases run in"
echo "      kubectl apply -f ${EXAMPLES}/project-defaults.yaml   # edit the ingress hosts first"
echo "      kubectl apply -f ${EXAMPLES}/project.yaml           # its spec.locations name your locations"
echo "      kubectl apply -f ${EXAMPLES}/minimal.yaml"
