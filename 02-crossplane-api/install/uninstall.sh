#!/usr/bin/env bash
# Removes the PostgresCluster API. Refuses while PostgresClusters exist,
# because deleting the XRD would cascade-delete every database it manages.
# Crossplane core stays installed unless UNINSTALL_CROSSPLANE=true.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="${SCRIPT_DIR}/../apis"
CROSSPLANE_NAMESPACE="${CROSSPLANE_NAMESPACE:-crossplane-system}"

if kubectl get crd postgresclusters.cnpg.cncp.nl >/dev/null 2>&1; then
  remaining="$(kubectl get postgresclusters.cnpg.cncp.nl -A --no-headers 2>/dev/null | wc -l)"
  if [[ "${remaining}" -gt 0 ]]; then
    echo "ERROR: ${remaining} PostgresCluster(s) still exist; delete them first:" >&2
    kubectl get postgresclusters.cnpg.cncp.nl -A >&2
    exit 1
  fi
fi

kubectl delete -f "${API_DIR}/postgrescluster/composition.yaml" --ignore-not-found
kubectl delete -f "${API_DIR}/postgrescluster/definition.yaml" --ignore-not-found
kubectl delete -f "${SCRIPT_DIR}/functions.yaml" --ignore-not-found
kubectl delete -f "${SCRIPT_DIR}/rbac.yaml" --ignore-not-found

if [[ "${UNINSTALL_CROSSPLANE:-false}" == "true" ]]; then
  helm uninstall crossplane -n "${CROSSPLANE_NAMESPACE}"
fi
