#!/usr/bin/env bash
# Installs the upstream COSI CRDs/controller and the cloudian-cosi-driver
# Helm chart. https://github.com/cloudian/cloudian-cosi-driver
#
# This is the "infrastructure" half of the COSI setup: CRDs, the
# cluster-wide controller, the driver itself, and the RBAC workaround it
# needs. It does not create any buckets - run deploy-cosi-buckets.sh
# afterwards for that.
#
# Usage:
#   ./deploy-cosi-crds-driver.sh
#
# Removal (separate scripts, run in this order):
#   ./remove-cosi-bucket-resources.sh  # BucketClass/BucketClaim/BucketAccess/etc
#   ./remove-cosi-driver.sh            # helm release + RBAC + upstream CRDs/controller
#
# Manifests applied by this script live in manifests/: the RBAC workaround
# as a .yaml template rendered with envsubst (see lib.sh's
# render_manifest()), and the upstream COSI CRDs/controller as vendored,
# pinned .yaml in manifests/upstream/ (see the header comments in those
# files for why they're vendored rather than fetched via `-k github.com/...`).
# The cloudian-cosi-driver Helm chart is vendored the same way, unpacked in
# manifests/upstream/charts/cosi-driver (chart 1.0.0, pulled from
# oci://quay.io/cloudian/cosi-driver) and installed from that local path, so
# installs don't depend on the registry or float to whatever is newest.
# To bump it:
#   helm pull oci://quay.io/cloudian/cosi-driver --version <ver> --untar \
#     --untardir manifests/upstream/charts
#
# Required env vars (no defaults - never guess credentials or infra endpoints):
#   COSI_S3_ENDPOINT            e.g. https://s3-eu.ring1.kos.kpn.com
#   COSI_IAM_ENDPOINT           e.g. https://s3-eu.ring1.kos.kpn.com:16443
#   COSI_REGION                 e.g. region-1
#   COSI_ACCESS_KEY             HyperStore access key used by the driver itself
#   COSI_SECRET_ACCESS_KEY      HyperStore secret key used by the driver itself
#
# Optional env vars:
#   NAMESPACE                   default: zs3-cosi-test
#   RELEASE_NAME                default: cloudian-cosi-driver
#   DISABLE_TLS_CERT_CHECK      true|false, default: false (the KPN endpoints present a
#                                certSIGN-issued cert that validates against the system CA store;
#                                only set true for an endpoint with a self-signed cert)
set -euo pipefail

source ../../env/00-env.sh
# export COSI_ACCESS_KEY='****************'
# export COSI_SECRET_ACCESS_KEY='****************'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

# shellcheck disable=SC1091
[ -f "${SCRIPT_DIR}/../../../env/00-env.sh" ] && source "${SCRIPT_DIR}/../../../env/00-env.sh"
export COSI_S3_ENDPOINT='https://s3-eu.ring1.kos.kpn.com'
export COSI_IAM_ENDPOINT='https://s3-eu.ring1.kos.kpn.com:16443'
export COSI_REGION='us-east-01'

CHART_DIR="${MANIFEST_DIR}/manifests/upstream/charts/cosi-driver"

SCRATCH_DIR="$(mktemp -d)"
trap 'rm -rf "${SCRATCH_DIR}"' EXIT

require_env() {
  local missing=()
  for var in COSI_S3_ENDPOINT COSI_IAM_ENDPOINT COSI_REGION COSI_ACCESS_KEY COSI_SECRET_ACCESS_KEY; do
    [ -n "${!var:-}" ] || missing+=("$var")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "Missing required env vars: ${missing[*]}" >&2
    exit 1
  fi
}

install_cosi_crds() {
  echo "Applying COSI API + controller manifests..."
  kubectl apply --server-side -f "${MANIFEST_DIR}/manifests/upstream/cosi-api.yaml"
  kubectl apply --server-side -f "${MANIFEST_DIR}/manifests/upstream/cosi-controller.yaml"
}

render_values() {
  render_manifest helm-values.yaml > "${SCRATCH_DIR}/values.yaml"
}

helm_deploy() {
  echo "Deploying ${RELEASE_NAME} into namespace ${NAMESPACE}..."
  helm upgrade --install "${RELEASE_NAME}" "${CHART_DIR}" \
    --namespace "${NAMESPACE}" --create-namespace \
    -f "${SCRATCH_DIR}/values.yaml" \
    --wait --timeout 5m
}

grant_driver_rbac() {
  echo "Granting objectstorage-provisioner-role to ${NAMESPACE}:default (chart RBAC is hardcoded to the 'default' namespace)..."
  render_manifest clusterrolebinding.yaml | kubectl apply -f -
}

require_env
check_prereqs
install_cosi_crds
render_values
helm_deploy
grant_driver_rbac

echo "Driver + CRDs installed. Run ./deploy-cosi-buckets.sh to create test buckets."
