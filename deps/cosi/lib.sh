source ../../env/00-env.sh

# Shared config and helpers for deploy-cosi-driver.sh / remove-cosi-driver.sh.
# Must be sourced (not executed) after the caller has set -euo pipefail.

MANIFEST_DIR="${SCRIPT_DIR}"

# --- Config ---------------------------------------------------------------
NAMESPACE="${NAMESPACE:-zs3-cosi-test}"
RELEASE_NAME="${RELEASE_NAME:-cloudian-cosi-driver}"
AUTH_TYPE="${AUTH_TYPE:-IAM}"
DISABLE_TLS_CERT_CHECK="${DISABLE_TLS_CERT_CHECK:-false}"
BUCKET_NAME_PREFIX="${BUCKET_NAME_PREFIX:-cosi-test}"

# Space-separated bucket suffixes - one BucketClaim/BucketAccess/
# ServiceAccount per entry, all sharing the single BucketClass/
# BucketAccessClass below. Override e.g. BUCKET_NAMES="1 2 3".
read -ra BUCKET_NAMES <<< "${BUCKET_NAMES:-1 2}"

BUCKET_CLASS="${BUCKET_NAME_PREFIX}-bucketclass"
BUCKET_ACCESS_CLASS="${BUCKET_NAME_PREFIX}-bucketaccessclass"
CLUSTERROLEBINDING_NAME="${RELEASE_NAME}-${NAMESPACE}-provisioner-role-binding"

# Per-bucket resource names - call set_bucket_vars <suffix> before touching
# these or calling render_manifest with a bucket-scoped template
# (serviceaccount.yaml/bucketclaim.yaml/bucketaccess.yaml).
BUCKET_CLAIM=""
BUCKET_ACCESS=""
BUCKET_ACCESS_SECRET=""
BUCKET_ACCESS_SA=""

set_bucket_vars() {
  local suffix="$1"
  BUCKET_CLAIM="${BUCKET_NAME_PREFIX}-bucketclaim-${suffix}"
  BUCKET_ACCESS="${BUCKET_NAME_PREFIX}-bucketaccess-${suffix}"
  BUCKET_ACCESS_SECRET="${BUCKET_NAME_PREFIX}-secret-${suffix}"
  BUCKET_ACCESS_SA="${BUCKET_NAME_PREFIX}-sa-${suffix}"
  export BUCKET_CLAIM BUCKET_ACCESS BUCKET_ACCESS_SECRET BUCKET_ACCESS_SA
}

# The snap-packaged aws cli validates against its own bundled CA list, which
# lacks the certSIGN root the KPN endpoints chain to. Point it at the system
# store instead (same one curl/openssl use) unless the caller already set one.
if [ -z "${AWS_CA_BUNDLE:-}" ] && [ -f /etc/ssl/certs/ca-certificates.crt ]; then
  export AWS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
fi

export NAMESPACE RELEASE_NAME AUTH_TYPE DISABLE_TLS_CERT_CHECK BUCKET_CLASS \
  BUCKET_ACCESS_CLASS BUCKET_CLAIM BUCKET_ACCESS BUCKET_ACCESS_SECRET BUCKET_ACCESS_SA CLUSTERROLEBINDING_NAME

# Explicit allow-list of placeholders envsubst is permitted to expand in the
# manifests/ templates, so a stray "$..." in a template can't accidentally
# pick up an unrelated variable from the caller's environment.
COSI_TEMPLATE_VARS='${NAMESPACE} ${RELEASE_NAME} ${AUTH_TYPE} ${DISABLE_TLS_CERT_CHECK}'
COSI_TEMPLATE_VARS+=' ${BUCKET_CLASS} ${BUCKET_CLAIM} ${BUCKET_ACCESS_CLASS} ${BUCKET_ACCESS}'
COSI_TEMPLATE_VARS+=' ${BUCKET_ACCESS_SECRET} ${BUCKET_ACCESS_SA} ${CLUSTERROLEBINDING_NAME}'
COSI_TEMPLATE_VARS+=' ${COSI_S3_ENDPOINT} ${COSI_IAM_ENDPOINT} ${COSI_REGION} ${COSI_ACCESS_KEY} ${COSI_SECRET_ACCESS_KEY}'

require_bin() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing required binary: $1" >&2; exit 1; }
}

check_prereqs() {
  require_bin kubectl
  require_bin helm
  require_bin envsubst
  local helm_major helm_minor
  helm_major="$(helm version --template '{{.Version}}' | sed -E 's/^v([0-9]+)\..*/\1/')"
  helm_minor="$(helm version --template '{{.Version}}' | sed -E 's/^v[0-9]+\.([0-9]+)\..*/\1/')"
  if [ "${helm_major}" -lt 3 ] || { [ "${helm_major}" -eq 3 ] && [ "${helm_minor}" -lt 8 ]; }; then
    echo "helm v3.8+ is required for OCI chart support (found $(helm version --short))" >&2
    exit 1
  fi
}

# The v1alpha1 objectstorage-sidecar caches BucketAccess objects by
# namespace/name and sometimes misses the Delete event when one is removed.
# A BucketAccess recreated later under the same name is then handled as an
# "Update" of that stale entry, which never calls DriverGrantBucketAccess, so
# it sits forever with no status and no finalizer. Restarting the driver pod
# rebuilds the sidecar's cache from a fresh informer sync.
driver_deployed() {
  kubectl get deployment "${RELEASE_NAME}" -n "${NAMESPACE}" >/dev/null 2>&1
}

restart_driver() {
  echo "Restarting ${RELEASE_NAME} to reset the sidecar's BucketAccess cache..."
  kubectl rollout restart deployment "${RELEASE_NAME}" -n "${NAMESPACE}"
  kubectl rollout status deployment "${RELEASE_NAME}" -n "${NAMESPACE}" --timeout=180s
}

# Render a manifest template from manifests/, expanding only
# COSI_TEMPLATE_VARS placeholders.
render_manifest() {
  envsubst "${COSI_TEMPLATE_VARS}" < "${MANIFEST_DIR}/manifests/$1"
}
