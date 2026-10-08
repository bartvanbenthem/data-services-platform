"""Semantic assertions on `crossplane render` output for Project, see ../run.sh.

usage: assert.py <case> <empty|observed> <render-output.yaml>
"""
import base64
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


# On the control plane: the namespace (the PostgresCluster XRs live there),
# a Prometheus that only receives, Grafana. Namespaced objects only once the
# namespace exists.
HUB = {"namespace", "prometheus-serviceaccount", "prometheus", "prometheus-pvc", "grafana", "grafana-datasource"}
# In each location, wrapped in an Object named location-<location>-<name>:
# the namespace, a Prometheus that scrapes, access and quota. Rendered once
# the namespace on the control plane exists (the Objects live in it).
REMOTE = {"namespace", "prometheus-clusterrolebinding", "prometheus-serviceaccount", "prometheus", "prometheus-pvc"}

# With a backup bucket, in each location: its keys and the CronJob that checks
# it reaches the bucket.
CHECK = {"backup-check-s3", "backup-check"}


def at(location, keys):
    return {f"location-{location}-{k}" for k in keys}


EXPECTED = {
    "bare": {"empty": {"namespace", "usage-location-si-ske-demo"}},
    "minimal": {"empty": {"namespace", "usage-location-si-ske-demo"},
                "observed": HUB | {"usage-location-si-ske-demo"} | at("si-ske-demo", REMOTE)},
    "full": {"empty": {"namespace", "usage-location-si-ske-demo", "usage-location-onprem-ams"},
             "observed": HUB | {"access-0", "access-1", "usage-location-si-ske-demo", "usage-location-onprem-ams"}
             | at("si-ske-demo", REMOTE | {"access-0", "access-1", "quota", "limitrange"})
             | at("onprem-ams", REMOTE | {"access-0", "access-1", "quota", "limitrange"})},
    "sites": {"empty": {"namespace", "usage-location-si-ske-demo", "usage-location-onprem-ams"},
              "observed": HUB | {"access-0", "prometheus-remote-write",
                                 "usage-location-si-ske-demo", "usage-location-onprem-ams"}
              | at("si-ske-demo", REMOTE | {"access-0", "quota", "limitrange"})
              | at("onprem-ams", REMOTE | {"access-0", "quota", "limitrange"})},
    # COSI: the project's BucketClass from the start; the claim and an access per
    # location once the project namespace exists.
    "bucket": {"empty": {"namespace", "usage-location-si-ske-demo", "usage-location-onprem-ams", "backup-bucketclass"},
               "observed": HUB | {"usage-location-si-ske-demo", "usage-location-onprem-ams", "backup-bucketclass",
                                  "backup-bucket", "backup-access-si-ske-demo", "backup-access-onprem-ams",
                                  "backup-sa-si-ske-demo", "backup-sa-onprem-ams",
                                  "backup-s3-si-ske-demo", "backup-s3-onprem-ams"}
               | at("si-ske-demo", REMOTE | CHECK) | at("onprem-ams", REMOTE | CHECK)},
    # No Location "nowhere": no ClusterUsage for it, and the Project isn't ready.
    "unregistered": {"empty": {"namespace"}},
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
    if key != "namespace" and not key.startswith("usage-") and key != "backup-bucketclass":
        check(obj["metadata"].get("namespace") == name, f"{key}: not in the project namespace")
    check(obj["metadata"]["labels"].get("platform.cncp.nl/project") == name, f"{key}: missing project label")
sites = xr["spec"]["locations"]
ann = ns["metadata"]["annotations"]
check(ann.get("platform.cncp.nl/protected-location") == sites["protected"]
      and ann.get("platform.cncp.nl/recovery-location") == sites.get("recovery"),
      f"namespace must record the project's sites for the admission policy: {ann}")
check("platform.cncp.nl/locations" not in ann, "the old location list annotation is gone")
check("locationNames" not in status, "status.locationNames is gone")
# The Location of si-ske-demo (required/sites.yaml) says schedulable: false.
check(ann.get("platform.cncp.nl/unschedulable-locations") == ("si-ske-demo" if case == "sites" else None),
      "namespace must list the locations closed to new databases for the admission policy")

# --- the COSI backup bucket
check((ann.get("platform.cncp.nl/backup-bucket") == "true") == (case == "bucket"),
      "namespace must say whether the project has a backup bucket, for the admission policy")
if case == "bucket":
    cls = composed["backup-bucketclass"]
    check(cls["kind"] == "BucketClass" and cls["metadata"]["name"] == f"project-{name}-backups"
          and "namespace" not in cls["metadata"] and cls["deletionPolicy"] == "Retain"
          and cls["driverName"] == "cloudian-cosi-driver" and cls["parameters"] == {"storagePolicy": "replicated-3"},
          f"BucketClass must keep the backups (Retain) and use the driver from project-defaults: {cls}")
    if state == "observed":
        claim = composed["backup-bucket"]
        check(claim["kind"] == "BucketClaim" and claim["metadata"]["name"] == "backups"
              and claim["spec"] == {"bucketClassName": f"project-{name}-backups", "protocols": ["S3"]},
              f"BucketClaim {claim}")
        for loc in sites.values():
            acc = composed[f"backup-access-{loc}"]
            check(acc["kind"] == "BucketAccess" and acc["metadata"]["name"] == f"backups-{loc}"
                  and acc["spec"] == {"bucketClaimName": "backups", "bucketAccessClassName": "backups-keys",
                                      "credentialsSecretName": f"cosi-backups-{loc}",
                                      "serviceAccountName": f"backups-{loc}", "protocol": "S3"},
                  f"{loc}: BucketAccess {acc['spec']}")
            sa = composed[f"backup-sa-{loc}"]
            check(sa["kind"] == "ServiceAccount" and sa["metadata"]["name"] == f"backups-{loc}"
                  and sa["metadata"]["namespace"] == name and sa.get("automountServiceAccountToken") is False,
                  f"{loc}: the IAM access class needs a ServiceAccount: {sa}")
    backup = status.get("backup", {})
    check(backup.get("namespace", name) == name, f"status.backup {backup}")
    if state == "empty":
        check(backup.get("ready") is False and not backup.get("credentials"), f"status.backup {backup}")
        check("the backup bucket (COSI)" in status.get("message", ""), f"message {status.get('message')}")
    else:
        # COSI's Secrets are namespaced: they come back in .requiredResources only.
        check(backup.get("ready") is True and backup.get("bucket") == f"{name}-backups-0f3a"
              and backup.get("destinationPath") == f"s3://{name}-backups-0f3a/barman"
              and backup.get("endpoint") == "https://s3.example.com" and backup.get("region") == "region-1"
              and backup.get("credentials") == {loc: f"backup-s3-{loc}" for loc in sites.values()},
              f"status.backup {backup}")
        check("the backup bucket (COSI)" not in status.get("message", ""), f"message {status.get('message')}")
    # The inventory of backup folders: kept from the last status (old-db's
    # cluster is gone, its folder stays restorable), updated from the
    # clusters' ObjectStores in this bucket (ledger-db archives elsewhere).
    servers = {s["serverName"]: s for s in backup.get("servers", [])}
    if state == "empty":
        check(set(servers) == {"old-db", "orders-db"} and not any(s["active"] for s in servers.values()),
              f"before the bucket is known the last inventory stays, inactive: {servers}")
    else:
        check(list(servers) == ["old-db", "orders-db", "orders-db-onprem-ams"], f"servers {list(servers)}")
        check(servers["old-db"] == {"serverName": "old-db", "cluster": "old-db", "location": "si-ske-demo", "active": False,
                                    "postgresVersion": 16, "database": "app", "owner": "app",
                                    "firstRecoverabilityPoint": "2026-09-01T02:00:00Z",
                                    "lastSuccessfulBackup": "2026-09-30T02:00:00Z"}, f"old-db {servers['old-db']}")
        check(servers["orders-db"] == {"serverName": "orders-db", "cluster": "orders-db", "location": "si-ske-demo", "active": True,
                                       "postgresVersion": 17, "database": "orders", "owner": "orders",
                                       "firstRecoverabilityPoint": "2026-10-02T02:00:00Z",
                                       "lastSuccessfulBackup": "2026-10-08T02:00:00Z"}, f"orders-db {servers['orders-db']}")
        check(servers["orders-db-onprem-ams"]["location"] == "onprem-ams" and servers["orders-db-onprem-ams"]["active"]
              and "firstRecoverabilityPoint" not in servers["orders-db-onprem-ams"], f"{servers['orders-db-onprem-ams']}")
    if state != "empty":
        for i, loc in enumerate(sites.values()):
            sec = composed[f"backup-s3-{loc}"]
            data = {k: base64.b64decode(v).decode() for k, v in sec.get("data", {}).items()}
            check(sec["kind"] == "Secret" and sec["metadata"]["namespace"] == name
                  and data == {"ACCESS_KEY_ID": f"FAKEKEYID{i}", "ACCESS_SECRET_KEY": f"fake-secret-{i}",
                               "REGION": "region-1"},
                  f"{loc}: keys unpacked from COSI's BucketInfo: {sorted(data)}")
            # The check, from the location itself, with that location's keys.
            obj = composed[f"location-{loc}-backup-check-s3"]
            check(obj["spec"]["providerConfigRef"]["name"] == loc
                  and obj["spec"].get("references") == [
                      {"patchesFrom": {"apiVersion": "v1", "kind": "Secret", "name": f"backup-s3-{loc}",
                                       "namespace": name, "fieldPath": f}} for f in ("data", "type")]
                  and "data" not in obj["spec"]["forProvider"]["manifest"]
                  and "platform.cncp.nl/copy-from" not in obj["spec"]["forProvider"]["manifest"]["metadata"].get("annotations", {}),
                  f"{loc}: backup-check-s3 must copy backup-s3-{loc} from the control plane: {obj['spec']}")
            cj = composed[f"location-{loc}-backup-check"]["spec"]["forProvider"]["manifest"]
            pod = cj["spec"]["jobTemplate"]["spec"]["template"]["spec"]
            c = pod["containers"][0]
            env = {e["name"]: e.get("value") or e["valueFrom"]["secretKeyRef"]["name"] for e in c["env"]}
            check(cj["kind"] == "CronJob" and cj["metadata"]["namespace"] == name
                  and cj["spec"]["concurrencyPolicy"] == "Forbid"
                  and env == {"LOCATION": loc, "S3_ENDPOINT": "https://s3.example.com",
                              "S3_BUCKET": f"{name}-backups-0f3a", "ACCESS_KEY_ID": "backup-check-s3",
                              "ACCESS_SECRET_KEY": "backup-check-s3", "REGION": "backup-check-s3"}
                  and c["securityContext"]["readOnlyRootFilesystem"] and pod["securityContext"]["runAsNonRoot"],
                  f"{loc}: backup-check CronJob {cj['spec']}")
        # observe.py reports each CronJob's last run as successful.
        check(backup.get("reachability") == [
                  {"location": loc, "state": "Reachable", "lastCheckTime": "2026-01-01T00:05:00Z",
                   "lastSuccessTime": "2026-01-01T00:05:04Z"} for loc in sites.values()],
              f"status.backup.reachability {backup.get('reachability')}")
else:
    check("backup" not in status, "no backup status without COSI classes")

# --- registered locations: a ClusterUsage each, so the Location can't be deleted
for key, obj in composed.items():
    if not key.startswith("usage-location-"):
        continue
    loc = key[len("usage-location-"):]
    check(obj["kind"] == "ClusterUsage" and obj["apiVersion"] == "protection.crossplane.io/v1beta1",
          f"{key}: must be a ClusterUsage")
    check(obj["spec"]["of"] == {"apiVersion": "platform.cncp.nl/v1alpha1", "kind": "Location",
                                "resourceRef": {"name": loc}}, f"{key}: spec.of {obj['spec']['of']}")
    check(name in obj["spec"].get("reason", ""), f"{key}: reason must name the project")

# --- locations: Objects for the location's ClusterProviderConfig
remote = {}
for site, loc in sites.items():
    prefix = f"location-{loc}-"
    remote[site] = {k[len(prefix):]: o for k, o in composed.items() if k.startswith(prefix)}
    for key, obj in remote[site].items():
        check(obj["kind"] == "Object", f"{loc}/{key}: objects in a location must be Objects")
        check(obj["spec"]["providerConfigRef"] == {"kind": "ClusterProviderConfig", "name": loc},
              f"{loc}/{key}: providerConfigRef")
        manifest = obj["spec"]["forProvider"]["manifest"]
        leaked = [a for a in manifest["metadata"].get("annotations", {})
                  if "crossplane.io/" in a or a == "platform.cncp.nl/orphan"]
        check(not leaked, f"{loc}/{key}: composition annotations leaked into the manifest: {leaked}")
        if key not in ("namespace", "prometheus-clusterrolebinding"):
            check(manifest["metadata"].get("namespace") == name, f"{loc}/{key}: not in the project namespace there")
        policies = obj["spec"].get("managementPolicies")
        if key == "namespace":
            check(policies and "Delete" not in policies and "*" not in policies,
                  f"{loc}: the namespace in a location must never be deleted by Crossplane")
        else:
            check(policies is None, f"{loc}/{key}: only the namespace is orphaned")
for key, obj in composed.items():
    if not key.startswith("location-"):
        check(obj["kind"] != "Object", f"{key}: control-plane objects are composed directly")
check(not {"prometheus-clusterrolebinding", "quota", "limitrange"} & set(composed),
      "the control plane scrapes nothing and runs no databases: no Prometheus binding, no quota")

# --- observability wiring
for site, objs in remote.items():
    loc = sites[site]
    if "prometheus-clusterrolebinding" in objs:
        crb = objs["prometheus-clusterrolebinding"]["spec"]["forProvider"]["manifest"]
        check(crb["roleRef"]["name"] == "cnpg-platform:project-prometheus", "CRB must bind the shared ClusterRole")
        check(crb["subjects"] == [{"kind": "ServiceAccount", "name": "prometheus", "namespace": name}],
              "CRB subject must be the project's prometheus ServiceAccount")
    if "prometheus" not in objs:
        continue
    prom = objs["prometheus"]["spec"]["forProvider"]["manifest"]["spec"]
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
    check(prom.get("externalLabels") == {"location": loc, "site": site},
          f"{loc}: Prometheus must label its location and site: {prom.get('externalLabels')}")
    want_rw = [{"url": f"https://prometheus-{name}.example.com/api/v1/write"}] if case == "sites" else None
    check(prom.get("remoteWrite") == want_rw, f"{loc}: remoteWrite {prom.get('remoteWrite')}")
    check("enableRemoteWriteReceiver" not in prom, "only the control plane's Prometheus receives")

if "prometheus" in composed:
    prom = composed["prometheus"]["spec"]
    check(prom.get("enableRemoteWriteReceiver") is True, "the control plane's Prometheus receives remote writes")
    scraping = [k for k in prom if k.endswith("Selector") or k.endswith("NamespaceSelector")]
    check(not scraping, f"the control plane's Prometheus scrapes nothing: {scraping}")
    check("externalLabels" not in prom and "remoteWrite" not in prom, "the control plane's Prometheus only receives")

if "prometheus-pvc" in composed:
    # Must be the claim the StatefulSet's volumeClaimTemplate resolves to, or
    # Prometheus would get a second, unmanaged volume.
    pvc = composed["prometheus-pvc"]
    check(pvc["metadata"]["name"] == "prometheus-prometheus-db-prometheus-prometheus-0", "PVC name")
    vct = composed["prometheus"]["spec"]["storage"]["volumeClaimTemplate"]["spec"]
    check(pvc["spec"]["resources"] == vct["resources"], "PVC size must match the volumeClaimTemplate")
    check(pvc["spec"].get("storageClassName") == vct.get("storageClassName"), "PVC storageClass")

if "prometheus-remote-write" in composed:
    ing = composed["prometheus-remote-write"]
    rule = ing["spec"]["rules"][0]
    check(rule["host"] == f"prometheus-{name}.example.com", "remote-write ingress host")
    check([(p["path"], p["pathType"]) for p in rule["http"]["paths"]] == [("/api/v1/write", "Exact")],
          "the remote-write ingress must expose only /api/v1/write")
    check(ing["metadata"]["annotations"].get("nginx.ingress.kubernetes.io/whitelist-source-range") == "192.0.2.0/24",
          "ingress annotations from project-defaults")
    check(status.get("prometheus", {}).get("remoteWriteUrl") == f"https://prometheus-{name}.example.com/api/v1/write",
          "status.prometheus.remoteWriteUrl")

if "grafana" in composed:
    graf = composed["grafana"]
    check(graf["metadata"]["labels"].get("dashboards.paas.cncp.nl/scope") == name,
          "Grafana must carry the scope label dashboards select on")
    check(graf["spec"]["config"]["security"]["allow_embedding"] == "true", "embedding must be allowed")
    host = {"minimal": "grafana-demo.10.0.0.1.nip.io", "full": "grafana-team-payments.example.com",
            "sites": "grafana-team-ledger.example.com"}.get(case)
    if host is None:  # no Grafana ingress in this case's project-defaults
        check("ingress" not in graf["spec"] and "url" not in status.get("grafana", {}), "no ingress without hostTemplate")
    else:
        rules = graf["spec"]["ingress"]["spec"]["rules"]
        check(rules[0]["host"] == host, f"ingress host {rules[0]['host']!r} != {host!r}")
    if host is None:
        pass
    elif case == "full":
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

# --- access and quota: access on the control plane and in each location, quota only in the locations
if case == "full" and state == "observed":
    for where, objs in [("control plane", composed)] + [(sites[k], {f"access-{i}": o["spec"]["forProvider"]["manifest"]
                                                                       for i in (0, 1) for kk, o in v.items() if kk == f"access-{i}"})
                                                         for k, v in remote.items()]:
        bindings = {objs[k]["roleRef"]["name"]: objs[k]["subjects"][0]["name"] for k in ("access-0", "access-1")}
        check(bindings == {"edit": "payments-devs", "view": "auditors"}, f"{where}: RoleBindings {bindings}")
        names = {objs[k]["metadata"]["name"] for k in ("access-0", "access-1")}
        check(len(names) == 2, "RoleBinding names must be unique")
    for site, objs in remote.items():
        hard = objs["quota"]["spec"]["forProvider"]["manifest"]["spec"]["hard"]
        check(hard == {"requests.cpu": "8", "requests.memory": "32Gi", "limits.memory": "32Gi",
                       "requests.storage": "200Gi"}, f"{sites[site]}: quota {hard}")

# --- readiness / status
check(status.get("namespace") == name, "status.namespace")
if case == "bare":
    check("prometheus" not in status and "grafana" not in status, "disabled components must not be in status")
if case == "unregistered":
    check(status.get("message") == "no Location nowhere; register the cluster first",
          f"status.message {status.get('message')!r}")
    check(status.get("locations", []) == [{"location": "nowhere", "site": "protected", "ready": False,
                                           "message": "no Location nowhere; register the cluster first"}],
          f"status.locations {status.get('locations')}")
if state == "empty":
    check(status.get("ready") is False, "status.ready should be false before anything exists")
    check(conds.get("Ready", {}).get("status") == "False", "XR Ready should be False")
    check(conds.get("ObservabilityReady", {}).get("status") == "False", "ObservabilityReady should be False")
elif case != "bucket":
    check(status.get("ready") is True, f"status.ready should be true, got {status.get('ready')}")
    check(conds.get("Ready", {}).get("status") == "True", f"XR Ready should be True, got {conds.get('Ready')}")
    check(conds.get("ObservabilityReady", {}).get("status") == "True", "ObservabilityReady should be True")
    check(status.get("prometheus", {}).get("url") == f"http://prometheus-operated.{name}.svc:9090",
          "status.prometheus.url")
    want = [(sites[k], k, True) for k in ("protected", "recovery") if k in sites]
    check([(l["location"], l["site"], l["ready"]) for l in status.get("locations", [])] == want,
          f"status.locations {status.get('locations')}")
    if case != "sites" and "prometheus" in composed:
        check("Grafana shows none" in status.get("message", ""),
              f"without remote write the message must say Grafana stays empty: {status.get('message')}")

if errors:
    print(f"FAIL project {case}/{state}:")
    for e in errors:
        print(f"  - {e}")
    sys.exit(1)
print(f"OK project {case}/{state}: {len(composed)} composed resources")
