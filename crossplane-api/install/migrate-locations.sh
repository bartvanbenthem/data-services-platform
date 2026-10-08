#!/usr/bin/env bash
# One-off: turns locations registered before the Location API (a kubeconfig
# Secret labelled platform.cncp.nl/location=true, settings as JSON in its
# platform.cncp.nl/location-spec annotation, plus a ClusterProviderConfig the
# portal or add-location.sh created) into Location objects. Run it after
# install.sh, against the control plane (your current context).
#
# The Location composition takes over the existing ClusterProviderConfig of
# the same name (server-side apply), so Projects keep placing objects through
# it without interruption. Idempotent: existing Locations are left alone.
set -euo pipefail

LOCATIONS_NAMESPACE="${LOCATIONS_NAMESPACE:-cnpg-locations}"

kubectl wait xrd/locations.platform.cncp.nl --for=condition=Established --timeout=30s >/dev/null

kubectl -n "${LOCATIONS_NAMESPACE}" get secrets -l platform.cncp.nl/location=true -o json \
  | python3 -I -c '
import json, sys
ns = sys.argv[1]
FIELDS = ("displayName", "description", "environment", "provider", "region", "owner",
          "storageClass", "schedulable")
docs = []
for s in json.load(sys.stdin)["items"]:
    meta = s["metadata"]
    name = meta["name"]
    try:
        old = json.loads(meta.get("annotations", {}).get("platform.cncp.nl/location-spec", "{}"))
    except ValueError:
        print(f"WARNING: {name}: unreadable location-spec annotation, settings skipped", file=sys.stderr)
        old = {}
    spec = {k: old[k] for k in FIELDS if old.get(k) not in (None, "")}
    spec["credentials"] = {"secretRef": {"namespace": ns, "name": name, "key": "kubeconfig"}}
    docs.append({"apiVersion": "platform.cncp.nl/v1alpha1", "kind": "Location",
                 "metadata": {"name": name}, "spec": spec})
print(json.dumps({"apiVersion": "v1", "kind": "List", "items": docs}))
' "${LOCATIONS_NAMESPACE}" >"${TMPDIR:-/tmp}/locations.$$.json"
trap 'rm -f "${TMPDIR:-/tmp}/locations.$$.json"' EXIT

# create, not apply: a Location that already exists keeps its settings.
kubectl create -f "${TMPDIR:-/tmp}/locations.$$.json" 2>&1 | sed 's/^Error from server (AlreadyExists): /skipped: /' || true
echo "==> Locations"
kubectl get locations.platform.cncp.nl
