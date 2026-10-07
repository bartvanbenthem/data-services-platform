#!/usr/bin/env bash
# Installs Crossplane v2 core, function-go-templating, the RBAC Crossplane
# needs to compose CNPG objects, the PostgresCluster API and the Project API
# (XRD + Composition + admission policies) into the cluster your current
# kubeconfig context points at. Idempotent -- safe to re-run.
#
# REQUIRE_PROJECT=true also installs apis/project/require-project-policy.yaml:
# new PostgresClusters only in Project namespaces.
#
# Prerequisite: ../../01-operator/install.sh (CNPG operator, Barman Cloud
# plugin, ClusterImageCatalog). Prometheus Operator and grafana-operator CRDs
# must exist for the monitoring objects (or disable monitoring per cluster).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="${SCRIPT_DIR}/../apis"
CROSSPLANE_NAMESPACE="${CROSSPLANE_NAMESPACE:-crossplane-system}"
CROSSPLANE_VERSION="${CROSSPLANE_VERSION:-2.4.2}"
SKIP_CROSSPLANE="${SKIP_CROSSPLANE:-false}"
REQUIRE_PROJECT="${REQUIRE_PROJECT:-false}"

if [[ "${SKIP_CROSSPLANE}" != "true" ]]; then
  echo "==> Crossplane ${CROSSPLANE_VERSION} (helm) in ${CROSSPLANE_NAMESPACE}"
  helm repo add crossplane-stable https://charts.crossplane.io/stable >/dev/null 2>&1 || true
  helm repo update crossplane-stable >/dev/null
  helm upgrade --install crossplane crossplane-stable/crossplane \
    --version "${CROSSPLANE_VERSION}" \
    --namespace "${CROSSPLANE_NAMESPACE}" --create-namespace \
    --wait
fi

echo "==> RBAC for composed CNPG / monitoring objects"
kubectl apply -f "${SCRIPT_DIR}/rbac.yaml"

echo "==> function-go-templating"
kubectl apply -f "${SCRIPT_DIR}/functions.yaml"
kubectl wait function.pkg.crossplane.io/function-go-templating --for=condition=Healthy --timeout=300s

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

echo "==> Project admission policies (deletion protection)"
sed "s/system:serviceaccount:crossplane-system:crossplane'/system:serviceaccount:${CROSSPLANE_NAMESPACE}:crossplane'/" \
  "${API_DIR}/project/policies.yaml" | kubectl apply -f -
if [[ "${REQUIRE_PROJECT}" == "true" ]]; then
  echo "==> PostgresClusters require a Project namespace"
  kubectl apply -f "${API_DIR}/project/require-project-policy.yaml"
fi

EXAMPLES="$(cd "${SCRIPT_DIR}/.." && pwd)/examples"
echo "==> Done. Try:"
echo "      kubectl apply -f ${EXAMPLES}/project-defaults.yaml   # edit the Grafana ingress host first"
echo "      kubectl apply -f ${EXAMPLES}/project.yaml"
echo "      kubectl apply -f ${EXAMPLES}/minimal.yaml"
