#!/usr/bin/env bash
# Tears down the cloudian-cosi-driver Helm release, its RBAC workaround
# ClusterRoleBinding, and the upstream COSI CRDs/controller that
# deploy-cosi-crds-driver.sh applied via install_cosi_crds().
#
# Run ./remove-cosi-bucket-resources.sh FIRST: the driver's controller is
# what clears the cosi.objectstorage.k8s.io finalizers on any remaining
# BucketClaim/BucketAccess/Bucket objects during deletion, and this script
# removes that controller.
#
# The COSI CRDs/controller are cluster-scoped and may be shared by other
# COSI drivers/namespaces on this cluster - this prompts for confirmation
# unless FORCE=true.
#
# Usage:
#   ./remove-cosi-driver.sh
#
# Optional env vars (must match what deploy-cosi-driver.sh was run with,
# so the right names get deleted):
#   NAMESPACE                   default: zs3-cosi-test
#   RELEASE_NAME                default: cloudian-cosi-driver
#   FORCE                       true|false, default: false (skip the confirmation prompt)
set -euo pipefail

source ../../env/00-env.sh
# export COSI_ACCESS_KEY='****************'
# export COSI_SECRET_ACCESS_KEY='****************'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

FORCE="${FORCE:-false}"

confirm_crd_removal() {
  [ "${FORCE}" = "true" ] && return 0
  read -r -p "This also deletes the cluster-scoped COSI CRDs/controller, which may be shared by other COSI drivers on this cluster. Continue? [y/N] " reply
  case "${reply}" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "Aborted." >&2; exit 1 ;;
  esac
}

uninstall_driver() {
  echo "Uninstalling helm release ${RELEASE_NAME}..."
  helm uninstall "${RELEASE_NAME}" -n "${NAMESPACE}" --ignore-not-found
  kubectl delete clusterrolebinding "${CLUSTERROLEBINDING_NAME}" --ignore-not-found
}

# Reverse of install_cosi_crds() in deploy-cosi-driver.sh: controller before
# API/CRDs, so the controller isn't left watching a CRD that's disappearing
# out from under it.
uninstall_cosi_crds() {
  echo "Deleting COSI controller + API manifests..."
  kubectl delete -f "${MANIFEST_DIR}/manifests/upstream/cosi-controller.yaml" --ignore-not-found
  kubectl delete -f "${MANIFEST_DIR}/manifests/upstream/cosi-api.yaml" --ignore-not-found
}

check_prereqs
uninstall_driver
confirm_crd_removal
uninstall_cosi_crds
