#!/usr/bin/env bash
# Offline tests for the compositions -- no Kubernetes cluster.
#
#  1. postgrescluster/composition.yaml is up to date with its template + src/.
#  2. `crossplane render` (real function-go-templating image, XRD defaults
#     applied via --xrd) for every <api>/xr/<case>.yaml, first with nothing
#     observed, then with <api>/observed/<case>.yaml if present.
#     <api>/required/<case>.yaml (else <api>/required/default.yaml), if
#     present, mocks the resources the composition requests (the
#     project-defaults EnvironmentConfig, Locations, the Project), plus
#     <api>'s apis/<api>/sizes.yaml (the postgres-sizes catalog) if it has one.
#  3. `crossplane resource validate` of every rendered object against the
#     real CRD schemas: CNPG + Barman Cloud from ../../../operator/charts,
#     Prometheus Operator, grafana-operator, provider-kubernetes and
#     Crossplane's ClusterUsage from ../crds. The manifest inside each provider-kubernetes Object (what goes
#     to a remote location) is validated too. Core kinds (Namespace,
#     RoleBinding, ...) have no CRD and are skipped.
#  4. Semantic assertions (<api>/assert.py).
#
# Requires the crossplane CLI (v2), helm, python3 + PyYAML, and a Docker API
# (rootless podman works: export DOCKER_HOST=unix:///run/user/$UID/podman/podman.sock).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_ROOT="$(cd "${HERE}/../.." && pwd)"
OPERATOR_CHARTS="$(cd "${API_ROOT}/../operator/charts" && pwd)"
FUNCTIONS="${API_ROOT}/install/functions.yaml"
APIS=(postgrescluster project location)

if [[ -z "${DOCKER_HOST:-}" && -S "/run/user/${UID}/podman/podman.sock" ]]; then
  export DOCKER_HOST="unix:///run/user/${UID}/podman/podman.sock"
fi

OUT="$(mktemp -d)"
trap 'rm -rf "${OUT}"' EXIT

echo "=== generate --check"
python3 "${API_ROOT}/hack/generate.py" --check

echo "=== collecting CRD schemas"
SCHEMAS="${OUT}/schemas"
mkdir -p "${SCHEMAS}"
cp "${HERE}/../crds/"*.yaml "${SCHEMAS}/"
for api in "${APIS[@]}"; do
  cp "${API_ROOT}/apis/${api}/definition.yaml" "${SCHEMAS}/xrd-${api}.yaml"
done
helm template cnpg "${OPERATOR_CHARTS}/cloudnative-pg" --show-only templates/crds/crds.yaml > "${SCHEMAS}/cnpg-crds.yaml"
helm template barman "${OPERATOR_CHARTS}/plugin-barman-cloud" > "${OUT}/barman-all.yaml"
python3 -I - "${OUT}/barman-all.yaml" "${SCHEMAS}/barman-crds.yaml" <<'EOF'
import sys, yaml
docs = [d for d in yaml.safe_load_all(open(sys.argv[1])) if d and d.get("kind") == "CustomResourceDefinition"]
yaml.safe_dump_all(docs, open(sys.argv[2], "w"))
EOF

fail=0
for api in "${APIS[@]}"; do
  xrd="${API_ROOT}/apis/${api}/definition.yaml"
  composition="${API_ROOT}/apis/${api}/composition.yaml"
  dir="${HERE}/${api}"
  for xr in "${dir}"/xr/*.yaml; do
    case="$(basename "${xr}" .yaml)"
    mocks=()
    if [[ -f "${dir}/required/${case}.yaml" ]]; then
      mocks=("${dir}/required/${case}.yaml")
    elif [[ -f "${dir}/required/default.yaml" ]]; then
      mocks=("${dir}/required/default.yaml")
    fi
    # The shipped postgres-sizes catalog, as installed.
    [[ -f "${API_ROOT}/apis/${api}/sizes.yaml" ]] && mocks+=("${API_ROOT}/apis/${api}/sizes.yaml")
    required=()
    if [[ ${#mocks[@]} -gt 0 ]]; then
      for f in "${mocks[@]}"; do cat "${f}"; echo "---"; done >"${OUT}/required-${api}-${case}.yaml"
      required=(--required-resources="${OUT}/required-${api}-${case}.yaml")
    fi
    for state in empty observed; do
      args=()
      if [[ "${state}" == "observed" ]]; then
        [[ -f "${dir}/observed/${case}.yaml" ]] || continue
        args=(--observed-resources="${dir}/observed/${case}.yaml")
      fi
      out="${OUT}/${api}-${case}-${state}.yaml"
      echo "=== ${api}/${case} (${state}): render"
      if ! crossplane render "${xr}" "${composition}" "${FUNCTIONS}" --xrd "${xrd}" \
          --include-full-xr --include-function-results "${args[@]}" "${required[@]}" >"${out}" 2>"${out}.err"; then
        echo "FAIL: render errored"; cat "${out}.err"; fail=1; continue
      fi

      echo "=== ${api}/${case} (${state}): validate against CRD schemas"
      # Function Result documents are render output only, and core kinds have
      # no CRD to validate against.
      python3 -I - "${out}" "${out}.objects" <<'EOF'
import sys, yaml
CORE = {"v1", "rbac.authorization.k8s.io/v1", "networking.k8s.io/v1", "apiregistration.k8s.io/v1", "batch/v1"}
docs = [d for d in yaml.safe_load_all(open(sys.argv[1])) if d and d.get("kind") != "Result"]
docs += [d["spec"]["forProvider"]["manifest"] for d in list(docs) if d.get("kind") == "Object"]
yaml.safe_dump_all([d for d in docs if d.get("apiVersion") not in CORE], open(sys.argv[2], "w"))
EOF
      if ! crossplane resource validate "${SCHEMAS}" "${out}.objects" --skip-success-results >"${out}.validate" 2>&1; then
        echo "FAIL: schema validation"; cat "${out}.validate"; fail=1
      fi

      echo "=== ${api}/${case} (${state}): assertions"
      python3 -I "${dir}/assert.py" "${case}" "${state}" "${out}" "${API_ROOT}/src/dashboards/cnpg-cluster.json" || fail=1
    done
  done
done

if [[ "${fail}" -ne 0 ]]; then
  echo; echo "Render tests FAILED"; exit 1
fi
echo; echo "All render tests passed."
