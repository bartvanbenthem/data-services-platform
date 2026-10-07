"""Semantic assertions on `crossplane render` output for Project, see ../run.sh.

usage: assert.py <case> <empty|observed> <render-output.yaml>
"""
import sys

import yaml

case, state, path = sys.argv[1:4]
docs = [d for d in yaml.safe_load_all(open(path)) if d]
xr = next(d for d in docs if d["kind"] == "Project")
composed = {d["metadata"]["annotations"]["crossplane.io/composition-resource-name"]: d
            for d in docs if d["kind"] not in ("Project", "Result")}
status = xr.get("status", {})
conds = {c["type"]: c for c in status.get("conditions", [])}
name = xr["metadata"]["name"]
errors = []


def check(ok, msg):
    if not ok:
        errors.append(msg)


# Before the Namespace exists only cluster-scoped objects are rendered.
OBSERVABILITY = {"namespace", "prometheus-clusterrolebinding", "prometheus-serviceaccount",
                 "prometheus", "grafana", "grafana-datasource"}
EXPECTED = {
    "bare": {"empty": {"namespace"}},
    "minimal": {"empty": {"namespace", "prometheus-clusterrolebinding"}, "observed": OBSERVABILITY},
    "full": {"empty": {"namespace", "prometheus-clusterrolebinding"},
             "observed": OBSERVABILITY | {"access-0", "access-1", "quota", "limitrange"}},
}
expected = EXPECTED[case][state]
check(set(composed) == expected, f"composed resources {sorted(composed)} != expected {sorted(expected)}")

# --- namespace: the labels PostgresClusters and Backstage key on
ns = composed["namespace"]
labels = ns["metadata"]["labels"]
check(ns["metadata"]["name"] == name, "namespace name must equal the project name")
check(labels.get("platform.cncp.nl/project") == name, "namespace missing platform.cncp.nl/project label")
check(labels.get("dashboards.paas.cncp.nl/scope") == name,
      "namespace scope label must match the PostgresCluster dashboards' default instanceSelector")
check(labels.get("pod-security.kubernetes.io/enforce") == "baseline", "pod security baseline not enforced")
if xr["spec"].get("owner"):
    check(labels.get("backstage.io/owner") == xr["spec"]["owner"], "owner label not set on namespace")
for key, obj in composed.items():
    if key not in ("namespace", "prometheus-clusterrolebinding"):
        check(obj["metadata"].get("namespace") == name, f"{key}: not in the project namespace")
    check(obj["metadata"]["labels"].get("platform.cncp.nl/project") == name, f"{key}: missing project label")

# --- observability wiring
if "prometheus-clusterrolebinding" in composed:
    crb = composed["prometheus-clusterrolebinding"]
    check(crb["roleRef"]["name"] == "cnpg-platform:project-prometheus", "CRB must bind the shared ClusterRole")
    check(crb["subjects"] == [{"kind": "ServiceAccount", "name": "prometheus", "namespace": name}],
          "CRB subject must be the project's prometheus ServiceAccount")

if "prometheus" in composed:
    prom = composed["prometheus"]["spec"]
    check(prom["serviceAccountName"] == "prometheus", "Prometheus must use its ServiceAccount")
    pm_ns = prom["podMonitorNamespaceSelector"]["matchExpressions"][0]["values"]
    check(prom["podMonitorSelector"] == {} and pm_ns == [name, "cnpg-system"],
          "Prometheus must scrape this namespace's and the CNPG operator's PodMonitors")
    rule_ns = prom["ruleNamespaceSelector"]["matchExpressions"][0]["values"]
    if case == "full":
        check(prom["retention"] == "30d", "retention not passed through")
        vct = prom["storage"]["volumeClaimTemplate"]["spec"]
        check(vct.get("storageClassName") == "fast" and vct["resources"]["requests"]["storage"] == "50Gi",
              "Prometheus storage not passed through")
        # From the EnvironmentConfig.
        check(rule_ns == [name, "monitoring"], f"ruleNamespaceSelector {rule_ns}")
        check(prom["serviceMonitorSelector"]["matchLabels"] == {"release": "kps"}, "serviceMonitorLabels from env")
        check(prom["serviceMonitorSelector"]["matchExpressions"][0]["values"] == ["kube-prometheus-stack-apiserver"],
              "excludeApps from env")
    else:
        check(rule_ns == [name, "prometheus-operator-system"], f"default ruleNamespaceSelector {rule_ns}")
        check(prom["serviceMonitorSelector"]["matchLabels"] == {"release": "prometheus-operator"},
              "default serviceMonitorLabels")

if "grafana" in composed:
    graf = composed["grafana"]
    check(graf["metadata"]["labels"].get("dashboards.paas.cncp.nl/scope") == name,
          "Grafana must carry the scope label dashboards select on")
    check(graf["spec"]["config"]["security"]["allow_embedding"] == "true", "embedding must be allowed")
    host = {"minimal": "grafana-demo.10.0.0.1.nip.io", "full": "grafana-team-payments.example.com"}[case]
    rules = graf["spec"]["ingress"]["spec"]["rules"]
    check(rules[0]["host"] == host, f"ingress host {rules[0]['host']!r} != {host!r}")
    if case == "full":
        check(graf["spec"]["ingress"]["spec"]["tls"] == [{"hosts": [host], "secretName": "wildcard-example-com"}],
              "TLS from env")
        check(status.get("grafana", {}).get("url") == f"https://{host}", "status.grafana.url must use https")
    else:
        check(status.get("grafana", {}).get("url") == f"http://{host}", "status.grafana.url")

if "grafana-datasource" in composed:
    ds = composed["grafana-datasource"]["spec"]
    check(ds["datasource"]["name"] == "prometheus", "datasource must be named 'prometheus'")
    check(ds["datasource"]["url"] == f"http://prometheus-operated.{name}.svc:9090", "datasource url")
    check(ds["instanceSelector"]["matchLabels"] == {"dashboards.paas.cncp.nl/scope": name}, "datasource selector")

# --- access and quota
if case == "full" and state == "observed":
    bindings = {composed[k]["roleRef"]["name"]: composed[k]["subjects"][0]["name"] for k in ("access-0", "access-1")}
    check(bindings == {"edit": "payments-devs", "view": "auditors"}, f"RoleBindings {bindings}")
    names = {composed[k]["metadata"]["name"] for k in ("access-0", "access-1")}
    check(len(names) == 2, "RoleBinding names must be unique")
    hard = composed["quota"]["spec"]["hard"]
    check(hard == {"requests.cpu": "8", "requests.memory": "32Gi", "limits.memory": "32Gi",
                   "requests.storage": "200Gi"}, f"quota {hard}")

# --- readiness / status
check(status.get("namespace") == name, "status.namespace")
if case == "bare":
    check("prometheus" not in status and "grafana" not in status, "disabled components must not be in status")
if state == "empty":
    check(status.get("ready") is False, "status.ready should be false before anything exists")
    check(conds.get("Ready", {}).get("status") == "False", "XR Ready should be False")
    check(conds.get("ObservabilityReady", {}).get("status") == "False", "ObservabilityReady should be False")
else:
    check(status.get("ready") is True, f"status.ready should be true, got {status.get('ready')}")
    check(conds.get("Ready", {}).get("status") == "True", f"XR Ready should be True, got {conds.get('Ready')}")
    check(conds.get("ObservabilityReady", {}).get("status") == "True", "ObservabilityReady should be True")
    check(status.get("prometheus", {}).get("url") == f"http://prometheus-operated.{name}.svc:9090",
          "status.prometheus.url")

if errors:
    print(f"FAIL project {case}/{state}:")
    for e in errors:
        print(f"  - {e}")
    sys.exit(1)
print(f"OK project {case}/{state}: {len(composed)} composed resources")
