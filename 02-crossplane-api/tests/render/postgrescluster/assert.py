"""Semantic assertions on `crossplane render` output, see run.sh.

usage: assert.py <case> <empty|observed> <render-output.yaml> <dashboard.json>
"""
import json
import sys

import yaml

case, state, path, dashboard_src = sys.argv[1:5]
docs = [d for d in yaml.safe_load_all(open(path)) if d]
xr = next(d for d in docs if d["kind"] == "PostgresCluster")
composed = {d["metadata"]["annotations"]["crossplane.io/composition-resource-name"]: d
            for d in docs if d["kind"] not in ("PostgresCluster", "Result")}
status = xr.get("status", {})
conds = {c["type"]: c for c in status.get("conditions", [])}
errors = []


def check(ok, msg):
    if not ok:
        errors.append(msg)


EXPECTED = {
    "bare": {"cluster"},
    "minimal": {"cluster", "podmonitor", "prometheusrule", "dashboard"},
    "production": {"cluster", "objectstore", "scheduled-backup", "database-payments-audit",
                   "pooler-rw", "pooler-ro", "podmonitor", "podmonitor-pooler",
                   "prometheusrule", "dashboard"},
}
check(set(composed) == EXPECTED[case],
      f"composed resources {sorted(composed)} != expected {sorted(EXPECTED[case])}")

name, ns = xr["metadata"]["name"], xr["metadata"]["namespace"]
for key, obj in composed.items():
    check(obj["metadata"].get("namespace") == ns, f"{key}: not in XR namespace {ns}")
    check(obj["metadata"]["labels"].get("cnpg.cncp.nl/postgrescluster") == name,
          f"{key}: missing cnpg.cncp.nl/postgrescluster label")

# --- readiness / status
if state == "empty":
    check(status.get("ready") is False, "status.ready should be false before the Cluster exists")
    check(conds.get("PostgresReady", {}).get("status") == "False", "PostgresReady should be False")
    check(conds.get("Ready", {}).get("status") == "False", "XR Ready should be False")
else:
    check(status.get("ready") is True, f"status.ready should be true, got {status.get('ready')}")
    check(status.get("readyInstances") == 3, "readyInstances should be 3")
    check(status.get("currentPrimary") == f"{name}-1", "currentPrimary not mirrored")
    check(conds.get("PostgresReady", {}).get("status") == "True", "PostgresReady should be True")
    check(conds.get("Ready", {}).get("status") == "True",
          f"XR Ready should be True, got {conds.get('Ready')}")
    if case == "production":
        check(status.get("backup", {}).get("lastSuccessfulBackup") == "2026-10-07T02:00:41Z",
              "backup.lastSuccessfulBackup not mirrored from ObjectStore")

check(status.get("endpoints", {}).get("readWrite") == f"{name}-rw.{ns}.svc", "endpoints.readWrite")
check(status.get("secrets", {}).get("app") == f"{name}-app", "secrets.app")

if case == "bare":
    spec = composed["cluster"]["spec"]
    check("postgresql" not in spec, "empty postgresql block must be omitted")
    check("topologySpreadConstraints" not in spec, "zoneSpread: false must drop the zone constraint")
    check(spec.get("enableSuperuserAccess") is True, "enableSuperuserAccess not passed through")
    check(status.get("secrets", {}).get("superuser") == f"{name}-superuser", "secrets.superuser")
    check("monitoring" not in status, "no dashboard uid without a dashboard")

# --- dashboard
if "dashboard" in composed:
    dash = composed["dashboard"]
    model = json.loads(dash["spec"]["json"])
    source = json.load(open(dashboard_src))
    uid = dash["spec"]["uid"]
    check(model["uid"] == uid == status.get("monitoring", {}).get("dashboardUid"), "dashboard uid mismatch")
    check(len(uid) <= 40, "Grafana uids are limited to 40 chars")
    check(model["title"] == f"CloudNativePG / {ns} / {name}", f"dashboard title {model['title']!r}")
    check(len(model["panels"]) == len(source["panels"]), "dashboard panels differ from source JSON")
    current = {v["name"]: v.get("current", {}).get("value") for v in model["templating"]["list"]}
    check(current.get("namespace") == ns and current.get("cluster") == name, "dashboard variables not preset")
    # Grafana legend templates like {{pod}} must survive function-go-templating verbatim.
    check(json.dumps(model).count("{{") == json.dumps(source).count("{{"), "dashboard {{ }} legend formats altered")

# --- alerts
if "prometheusrule" in composed:
    rules = composed["prometheusrule"]["spec"]["groups"][0]["rules"]
    alerts = [r["alert"] for r in rules]
    excluded = xr["spec"].get("monitoring", {}).get("prometheusRule", {}).get("excludeRules", [])
    check(len(alerts) == 19 - len(excluded), f"expected {19 - len(excluded)} alert rules, got {len(alerts)}")
    check(not set(alerts) & set(excluded), "excluded rules still present")
    text = yaml.safe_dump(rules)
    check("zz" not in text, "unsubstituted placeholder in alert rules")
    check("{{ $labels.pod }}" in text or "{{ $value }}" in text, "Prometheus templating not preserved")
    check(f'namespace="{ns}"' in text, "alert expressions not scoped to the namespace")

if errors:
    print(f"FAIL {case}/{state}:")
    for e in errors:
        print(f"  - {e}")
    sys.exit(1)
print(f"OK {case}/{state}: {len(composed)} composed resources")
