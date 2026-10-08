"""Semantic assertions on `crossplane render` output for Location, see ../run.sh.

usage: assert.py <case> <empty|observed> <render-output.yaml>
"""
import os
import sys

import yaml

case, state, path = sys.argv[1:4]
docs = [d for d in yaml.safe_load_all(open(path)) if d]
xr = next(d for d in docs if d["kind"] == "Location")
composed = {d["metadata"]["annotations"]["crossplane.io/composition-resource-name"]: d
            for d in docs if d["kind"] not in ("Location", "Result")}
status = xr.get("status", {})
name = xr["metadata"]["name"]
ref = xr["spec"]["credentials"]["secretRef"]
errors = []


def check(ok, msg):
    if not ok:
        errors.append(msg)


check(set(composed) == {"providerconfig", "prometheus-role", "cnpg", "prometheus-operator"},
      f"composed resources {sorted(composed)}")

# --- the ClusterProviderConfig the Project/PostgresCluster compositions use
pc = composed["providerconfig"]
check(pc["kind"] == "ClusterProviderConfig" and pc["metadata"]["name"] == name,
      "ClusterProviderConfig must be named after the location")
check(pc["spec"]["credentials"] == {"source": "Secret", "secretRef": {
    "namespace": ref["namespace"], "name": ref["name"], "key": ref.get("key", "kubeconfig")}},
      f"credentials {pc['spec']['credentials']}")

# --- Objects in the location
for key in ("prometheus-role", "cnpg", "prometheus-operator"):
    obj = composed[key]
    check(obj["kind"] == "Object", f"{key}: must be an Object")
    check(obj["metadata"]["namespace"] == ref["namespace"], f"{key}: not next to the kubeconfig Secret")
    check(obj["metadata"]["name"].startswith(f"{name}-"), f"{key}: name not prefixed with the location")
    check(obj["spec"]["providerConfigRef"] == {"kind": "ClusterProviderConfig", "name": name},
          f"{key}: providerConfigRef")
role = composed["prometheus-role"]
check("Delete" not in role["spec"]["managementPolicies"],
      "the Prometheus ClusterRole must outlive the Location (projects' bindings there use it)")
check(role["spec"]["forProvider"]["manifest"]["metadata"]["name"] == "cnpg-platform:project-prometheus",
      "the ClusterRole name must match what the Project composition binds")
installed = yaml.safe_load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                             "../../../install/project-prometheus-role.yaml")))
check(role["spec"]["forProvider"]["manifest"]["rules"] == installed["rules"],
      "ClusterRole rules differ from install/project-prometheus-role.yaml")
for key, group in (("cnpg", "postgresql.cnpg.io"), ("prometheus-operator", "monitoring.coreos.com")):
    obj = composed[key]
    check(obj["spec"]["managementPolicies"] == ["Observe"], f"{key}: must only observe")
    check(obj["spec"]["forProvider"]["manifest"]["metadata"]["name"] == f"v1.{group}", f"{key}: APIService")

# --- status
expected = {
    ("minimal", "empty"): dict(ready=False, connected=False, providerConfig=None, operators=None,
                               message="Creating the ClusterProviderConfig"),
    ("unreachable", "empty"): dict(ready=False, connected=False, providerConfig=None, operators=None,
                                   message="Creating the ClusterProviderConfig"),
    ("minimal", "observed"): dict(ready=False, connected=True, providerConfig=name,
                                  operators={"cloudnativepg": True, "prometheusOperator": False},
                                  message="Connected; the Prometheus Operator CRDs not installed (run operator/install.sh against it)"),
    ("ready", "empty"): dict(ready=False, connected=False, providerConfig=None, operators=None,
                             message="Creating the ClusterProviderConfig"),
    ("ready", "observed"): dict(ready=True, connected=True, providerConfig=name,
                                operators={"cloudnativepg": True, "prometheusOperator": True},
                                message=f"Location {name} is ready"),
    ("unreachable", "observed"): dict(ready=False, connected=False, providerConfig=name, operators=None,
                                      message="Can't reach the cluster: connect failed: dial tcp 10.0.0.9:6443: i/o timeout"),
}[(case, state)]
for k, v in expected.items():
    check(status.get(k) == v, f"status.{k} = {status.get(k)!r}, want {v!r}")

# function-go-templating turns the ready annotations into the XR's Ready.
conds = {c["type"]: c for c in status.get("conditions", [])}
want = "True" if status.get("ready") else "False"
check(conds.get("Ready", {}).get("status") == want, f"XR Ready {conds.get('Ready')}, want {want}")
check(conds.get("LocationReady", {}).get("status") == want, f"LocationReady {conds.get('LocationReady')}")

if errors:
    print(f"FAIL location/{case} ({state}):")
    for e in errors:
        print("  -", e)
    sys.exit(1)
print(f"ok   location/{case} ({state})")
