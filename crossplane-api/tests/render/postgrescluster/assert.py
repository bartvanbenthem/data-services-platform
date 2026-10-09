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
name, ns = xr["metadata"]["name"], xr["metadata"]["namespace"]
errors = []


def check(ok, msg):
    if not ok:
        errors.append(msg)


# One location's worth of objects with backups on, and the recovery site's
# copy (prefix recovery-). Every member copies the S3 Secret to its location.
MEMBER = {"cluster", "objectstore", "scheduled-backup", "podmonitor", "prometheusrule", "secret-orders-db-s3"}
REPLICATED = MEMBER | {"dashboard"} | {f"recovery-{k}" for k in MEMBER}
EXPECTED = {
    "bare": {"cluster"},
    "minimal": {"cluster", "podmonitor", "prometheusrule", "dashboard"},
    "pinned": {"cluster", "podmonitor", "prometheusrule", "dashboard"},
    "noproject": {"dashboard"},
    "production": {"cluster", "objectstore", "scheduled-backup", "database-payments-audit",
                   "pooler-rw", "pooler-ro", "podmonitor", "podmonitor-pooler",
                   "prometheusrule", "dashboard", "secret-payments-db-s3", "secret-payments-db-reporting"},
    "secrets": {"cluster", "objectstore", "scheduled-backup", "podmonitor", "prometheusrule",
                "pooler-rw", "podmonitor-pooler", "dashboard",
                "secret-ledger-db-s3", "secret-ledger-db-reporting"},
    "replicated": REPLICATED,
    "switchover": REPLICATED,
    "failover": REPLICATED,
    "promoted": REPLICATED,
    "draining": REPLICATED,
    # The Project's COSI bucket: the same set per site, with its own credentials copy.
    "projectbucket": {"cluster", "objectstore", "scheduled-backup", "podmonitor", "prometheusrule",
                      "secret-secrets-db-backup-s3", "dashboard"}
    | {f"recovery-{k}" for k in ("cluster", "objectstore", "scheduled-backup", "podmonitor", "prometheusrule",
                                 "secret-secrets-db-backup-s3")},
    "bucketpending": {"dashboard"},
    # Restored from the Project's bucket: the projectbucket set plus the
    # read-only restore store in the protected site.
    "restored": {"cluster", "objectstore", "scheduled-backup", "podmonitor", "prometheusrule",
                 "secret-secrets-db-r-backup-s3", "dashboard", "restore-objectstore"}
    | {f"recovery-{k}" for k in ("cluster", "objectstore", "scheduled-backup", "podmonitor", "prometheusrule",
                                 "secret-secrets-db-r-backup-s3")},
    # From a store of its own, without backups: no archive, only the restore store and its credentials.
    "restorecustom": {"cluster", "restore-objectstore", "secret-ledger-db-s3", "podmonitor", "prometheusrule"},
    "restorepending": {"dashboard"},
    "sized": {"cluster", "podmonitor", "prometheusrule", "dashboard"},
    "sizegone": {"cluster", "podmonitor", "prometheusrule", "dashboard"},
    "sizechanged": {"cluster", "podmonitor", "prometheusrule", "dashboard"},
    # An unknown size: nothing placed until it names one in the catalog.
    "sizeunknown": {"dashboard"},
}
check(set(composed) == EXPECTED[case],
      f"composed resources {sorted(composed)} != expected {sorted(EXPECTED[case])}")


def live(key):
    """The object a composed resource stands for: an Object's manifest, or itself."""
    obj = composed[key]
    return obj["spec"]["forProvider"]["manifest"] if obj["kind"] == "Object" else obj


# --- sites: the protected location from the Project (or status.sites), the
# recovery location for the recovery- objects. Nothing but the dashboard runs
# on the control plane.
PROTECTED = {"pinned": "onprem-rtm"}.get(case, "si-ske-demo")
RECOVERY = "onprem-ams"
GEO = case in ("replicated", "switchover", "failover", "promoted", "draining")
for key, obj in composed.items():
    if key == "dashboard":
        check(obj["kind"] == "GrafanaDashboard", "the dashboard is composed directly (Grafana runs on the control plane)")
        continue
    loc = RECOVERY if key.startswith("recovery-") else PROTECTED
    check(obj["kind"] == "Object", f"{key}: objects for location {loc} must be wrapped in an Object")
    if obj["kind"] != "Object":
        continue
    check(obj["spec"]["providerConfigRef"] == {"kind": "ClusterProviderConfig", "name": loc},
          f"{key}: providerConfigRef {obj['spec']['providerConfigRef']}")
    check(obj["metadata"]["annotations"].get("platform.cncp.nl/location") == loc, f"{key}: location annotation")
    manifest = obj["spec"]["forProvider"]["manifest"]
    leaked = [a for a in manifest["metadata"].get("annotations", {}) if "crossplane" in a or a.startswith("platform.cncp.nl/")]
    check(not leaked, f"{key}: composition annotations leaked into the manifest: {leaked}")
    check(manifest["metadata"]["namespace"] == ns, f"{key}: manifest not in namespace {ns}")
    if manifest["kind"] == "Secret":
        # Copied by reference: the value must never be in the Object spec.
        check("data" not in manifest and "stringData" not in manifest, f"{key}: Secret data in the Object spec")
        refs = [r["patchesFrom"] for r in obj["spec"].get("references", [])]
        check(sorted(r["fieldPath"] for r in refs) == ["data", "type"], f"{key}: Secret must be patched by reference: {refs}")
        # The Project bucket's credentials come from backup-s3-<location> (checked below); the rest from the same name here.
        if not key.endswith("-backup-s3"):
            check(all(r["kind"] == "Secret" and r["name"] == manifest["metadata"]["name"] and r["namespace"] == ns for r in refs),
                  f"{key}: Secret must be patched from {ns}/{manifest['metadata']['name']}: {refs}")

if case == "noproject":
    check(status.get("locations") == [] and "sites" not in status and "primaryLocation" not in status,
          f"no sites without a Project: {status}")
    check("not a Project with a protected location" in status.get("message", ""), f"message {status.get('message')}")
    check(conds.get("PostgresReady", {}).get("reason") == "NoSite", "PostgresReady reason NoSite")
elif case == "sizeunknown":
    check(status.get("locations") == [] and "sizing" not in status, f"nothing placed yet: {status}")
    check("size huge is not in the postgres-sizes catalog" in status.get("message", ""), f"message {status.get('message')}")
elif case in ("bucketpending", "restorepending"):
    check(status.get("locations") == [] and "backupStore" not in status, f"nothing placed yet: {status}")
    verb = "restore reads from" if case == "restorepending" else "backup uses"
    check(f"{verb} the backup bucket of Project vault, which isn't ready" in status.get("message", ""),
          f"message {status.get('message')}")
else:
    # The Projects in payments (required/default.yaml) and vault (projectbucket) have a recovery site.
    has_recovery = ns == "payments" or case in ("projectbucket", "restored")
    want_sites = {"protected": PROTECTED, **({"recovery": RECOVERY} if has_recovery else {})}
    check(status.get("sites") == want_sites, f"status.sites {status.get('sites')} != {want_sites}")

# --- backups in the Project's COSI bucket: one bucket, credentials per site from the Project's Secrets
if case in ("projectbucket", "restored"):
    store = {"destinationPath": "s3://vault-backups-0f3a/barman", "endpointURL": "https://s3.example.com",
             "namespace": "vault", "region": True}
    check(status.get("backupStore") == store, f"status.backupStore {status.get('backupStore')}")
    for prefix, loc in (("", PROTECTED), ("recovery-", RECOVERY)):
        cfg = live(f"{prefix}objectstore")["spec"]["configuration"]
        check(cfg["destinationPath"] == store["destinationPath"] and cfg["endpointURL"] == store["endpointURL"],
              f"{loc}: ObjectStore not in the project bucket: {cfg}")
        creds = cfg["s3Credentials"]
        check({creds[k]["name"] for k in ("accessKeyId", "secretAccessKey", "region")} == {f"{name}-backup-s3"}
              and (creds["accessKeyId"]["key"], creds["secretAccessKey"]["key"], creds["region"]["key"])
              == ("ACCESS_KEY_ID", "ACCESS_SECRET_KEY", "REGION"), f"{loc}: s3Credentials {creds}")
        secret = composed[f"{prefix}secret-{name}-backup-s3"]
        refs = [r["patchesFrom"] for r in secret["spec"]["references"]]
        check(all(r["namespace"] == "vault" and r["name"] == f"backup-s3-{loc}" for r in refs),
              f"{loc}: credentials must come from vault/backup-s3-{loc}: {refs}")
    if case == "projectbucket":
        check(live("objectstore")["spec"]["retentionPolicy"] == "14d", "the cluster's own backup settings stay")
        ext = {e["name"] for e in live("recovery-cluster")["spec"]["externalClusters"]}
        check(ext == {"secrets-db", "secrets-db-onprem-ams"}, f"externalClusters {ext}")
else:
    check("backupStore" not in status, "backupStore only for clusters on the Project's bucket")

# --- distributed topology
TOKEN = "eyJsc24iOiIwLzMwMDAwMDAifQ=="
if GEO:
    main, replica = live("cluster")["spec"], live("recovery-cluster")["spec"]
    topo = {"orders-db", "orders-db-onprem-ams"}
    for spec in (main, replica):
        ext = {e["name"]: e["plugin"]["parameters"] for e in spec["externalClusters"]}
        check(set(ext) == topo and all(p["serverName"] == n and p["barmanObjectName"] == "orders-db-backup"
                                       for n, p in ext.items()), f"externalClusters {ext}")
    check(main["replica"]["self"] == "orders-db" and replica["replica"]["self"] == "orders-db-onprem-ams",
          "replica.self must be the member's topology name")
    check("initdb" in main["bootstrap"] and replica["bootstrap"] == {"recovery": {"source": "orders-db"}},
          "the protected site runs initdb, the replica cluster recovers from it")
    check("serverName" not in main["plugins"][0]["parameters"], "the protected site keeps its archive folder")
    check(replica["plugins"][0]["parameters"]["serverName"] == "orders-db-onprem-ams",
          "the replica cluster archives to its own folder")
    check(live("recovery-cluster")["metadata"]["name"] == "orders-db",
          "every member's Cluster is named after the XR (stable service/secret names)")
    if case == "replicated":
        check(replica["instances"] == 2, "geoReplication.instances")
    # Who is primary, per case and state: (main.primary, replica.primary, token on the promoted member, status)
    want = {
        "replicated": ("orders-db", "orders-db", None, PROTECTED),
        "switchover/empty": ("orders-db-onprem-ams", "orders-db", None, PROTECTED),
        "switchover/observed": ("orders-db-onprem-ams", "orders-db-onprem-ams", TOKEN, RECOVERY),
        "failover": ("orders-db-onprem-ams", "orders-db-onprem-ams", None, RECOVERY),
        "promoted": ("orders-db-onprem-ams", "orders-db-onprem-ams", TOKEN, RECOVERY),
        # Draining: switching back to the protected site, waiting for onprem-ams' demotion token.
        "draining": ("orders-db-onprem-ams", "orders-db", None, RECOVERY),
    }
    exp = want.get(f"{case}/{state}", want.get(case))
    got = (main["replica"]["primary"], replica["replica"]["primary"],
           replica["replica"].get("promotionToken"), status.get("primaryLocation"))
    check(got == exp, f"(protected primary, recovery primary, token, status.primaryLocation) {got} != {exp}")
    check("promotionToken" not in main["replica"], "the protected site was never promoted here")
    if case != "draining":
        check(status.get("promotionToken") == exp[2], f"status.promotionToken {status.get('promotionToken')}")
    check(status.get("primarySite") == ("recovery" if exp[3] == RECOVERY else "protected"),
          f"status.primarySite {status.get('primarySite')}")
    sites = {l["location"]: l["site"] for l in status.get("locations", [])}
    check(sites == {PROTECTED: "protected", RECOVERY: "recovery"}, f"sites {sites}")
    roles = {l["location"]: l["role"] for l in status.get("locations", [])}
    if f"{case}/{state}" == "switchover/empty":
        check(roles == {PROTECTED: "primary", RECOVERY: "promoting"}, f"roles {roles}")
        check("waiting for the demotion token" in status.get("message", ""), f"message {status.get('message')}")
    elif case == "draining":
        check(roles == {PROTECTED: "promoting", RECOVERY: "primary"}, f"roles {roles}")
    else:
        primary = exp[3]
        check(roles == {primary: "primary", ({PROTECTED, RECOVERY} - {primary}).pop(): "replica"}, f"roles {roles}")
elif case not in ("noproject", "bucketpending", "projectbucket", "restored", "restorepending", "sizeunknown"):
    ext = [e["name"] for e in live("cluster")["spec"].get("externalClusters", [])]
    check("replica" not in live("cluster")["spec"] and ext == (["restore-source"] if "restore" in xr["spec"] else []),
          f"a single-site cluster has no replica topology: externalClusters {ext}")
    check(status.get("primaryLocation") == PROTECTED, f"status.primaryLocation {status.get('primaryLocation')}")
    check(status.get("primarySite") == "protected", f"status.primarySite {status.get('primarySite')}")
    check([(l["location"], l["site"]) for l in status.get("locations", [])] == [(PROTECTED, "protected")],
          "status.locations")

for key, obj in composed.items():
    check(obj["metadata"].get("namespace") == ns, f"{key}: not in XR namespace {ns}")
    check(obj["metadata"]["labels"].get("cnpg.cncp.nl/postgrescluster") == name,
          f"{key}: missing cnpg.cncp.nl/postgrescluster label")

# --- readiness / status
if state == "empty" or case in ("noproject", "bucketpending", "restorepending", "sizeunknown", "sizechanged"):
    check(status.get("ready") is False, "status.ready should be false before the Cluster exists")
    check(conds.get("PostgresReady", {}).get("status") == "False", "PostgresReady should be False")
    if case != "sizechanged":  # its composed resources are all there
        check(conds.get("Ready", {}).get("status") == "False", "XR Ready should be False")
else:
    check(status.get("ready") is True, f"status.ready should be true, got {status.get('ready')}")
    want_ready = live("cluster")["spec"]["instances"]
    check(status.get("readyInstances") == want_ready, f"readyInstances should be {want_ready}")
    check(status.get("currentPrimary") == f"{name}-1", "currentPrimary not mirrored")
    check(conds.get("PostgresReady", {}).get("status") == "True", "PostgresReady should be True")
    check(conds.get("Ready", {}).get("status") == "True",
          f"XR Ready should be True, got {conds.get('Ready')}")
    if case == "production":
        check(status.get("backup", {}).get("lastSuccessfulBackup") == "2026-10-07T02:00:41Z",
              "backup.lastSuccessfulBackup not mirrored from ObjectStore")

# --- sizing: spec.size from the postgres-sizes catalog (its resources and
# settings, spec.postgresql.parameters on top), else spec.resources or the
# defaults; status.sizing says what every site runs with.
DEFAULT_RESOURCES = {"requests": {"cpu": "500m", "memory": "1Gi"}, "limits": {"memory": "1Gi"}}
SIZING = {
    "sized": ("m", {"requests": {"cpu": "2", "memory": "8Gi"}, "limits": {"memory": "8Gi"}},
              {"shared_buffers": "2GB", "effective_cache_size": "6GB", "work_mem": "16MB",
               "maintenance_work_mem": "512MB", "max_connections": "200"}),
    # Kept from status.sizing: the catalog no longer has "retired".
    "sizegone": ("retired", {"requests": {"cpu": "3", "memory": "12Gi"}, "limits": {"memory": "12Gi"}},
                 {"shared_buffers": "3GB"}),
    # Not applied: the instances keep the size they had.
    "sizechanged": ("m", {"requests": {"cpu": "2", "memory": "8Gi"}, "limits": {"memory": "8Gi"}},
                    {"shared_buffers": "2GB"}),
    "production": ("", {"requests": {"cpu": "1", "memory": "4Gi"}, "limits": {"memory": "4Gi"}}, {}),
}
if case != "sizeunknown":
    size, resources, params = SIZING.get(case, ("", DEFAULT_RESOURCES, {}))
    want = {"size": size, "resources": resources, "parameters": params}
    check(status.get("sizing") == want, f"status.sizing {status.get('sizing')} != {want}")
    for key in ("cluster", "recovery-cluster"):
        if key not in composed:
            continue
        spec = live(key)["spec"]
        check(spec["resources"] == resources, f"{key}: resources {spec['resources']} != {resources}")
        got = spec.get("postgresql", {}).get("parameters", {})
        user = xr["spec"].get("postgresql", {}).get("parameters", {})
        check(got == {**params, **user}, f"{key}: parameters {got} != size's under spec's {{**{params}, **{user}}}")
if case == "sizechanged":
    check("size huge is not in the postgres-sizes catalog; the instances keep running as m" in status.get("message", ""),
          f"message {status.get('message')}")
if case == "sizegone":
    check("catalog" not in status.get("message", ""), f"a retired size is no problem: {status.get('message')}")

# --- backup folders: the cluster's name, a folder of its own per replica cluster.
# The Project keeps an inventory of them through the label on the ObjectStore's Object.
for key in composed:
    if key.endswith("objectstore") and not key.endswith("restore-objectstore"):
        manifest = live(key)
        folder = manifest["metadata"]["annotations"].get("cnpg.cncp.nl/server-name")
        params = live(key.replace("objectstore", "cluster"))["spec"]["plugins"][0]["parameters"]
        check(folder == params.get("serverName", name), f"{key}: server-name annotation {folder} != the folder archived to")
        check(composed[key]["metadata"]["labels"].get("cnpg.cncp.nl/backup-store") == "true",
              f"{key}: the Project finds backup folders by the cnpg.cncp.nl/backup-store label")
        check(manifest["metadata"]["annotations"].get("cnpg.cncp.nl/postgres-version") == str(xr["spec"].get("postgresVersion", 17)),
              f"{key}: postgres-version annotation")
    elif "objectstore" in key:
        check("cnpg.cncp.nl/backup-store" not in composed[key]["metadata"]["labels"],
              f"{key}: a restore source is not one of this cluster's backup folders")
if "objectstore" in composed and status.get("locations"):
    primary = next(l["location"] for l in status["locations"] if l["role"] == "primary")
    key = "objectstore" if primary == PROTECTED else "recovery-objectstore"
    check(status.get("backup", {}).get("serverName") == live(key)["metadata"]["annotations"]["cnpg.cncp.nl/server-name"],
          f"status.backup.serverName {status.get('backup')} is the primary's folder")

# --- restore: the protected site bootstraps from the source folder through a
# read-only store, and archives to a folder of its own.
if case in ("restored", "restorecustom"):
    restore = xr["spec"]["restore"]
    own = f"{name}-{xr['metadata']['uid'][:8]}"
    spec = live("cluster")["spec"]
    want = {"source": "restore-source", "database": xr["spec"].get("database", {}).get("name", "app"),
            "owner": xr["spec"].get("database", {}).get("owner", "app")}
    if "targetTime" in restore:
        want["recoveryTarget"] = {"targetTime": restore["targetTime"]}
    check(spec["bootstrap"] == {"recovery": want}, f"bootstrap {spec['bootstrap']} != {want}")
    ext = {e["name"]: e["plugin"]["parameters"] for e in spec["externalClusters"]}
    check(ext.get("restore-source") == {"barmanObjectName": f"{name}-restore", "serverName": restore["source"]["serverName"]},
          f"restore-source externalCluster {ext.get('restore-source')}")
    store = live("restore-objectstore")["spec"]
    check("retentionPolicy" not in store, "the restore store must never prune the source's backups")
    if case == "restored":
        check(status.get("backup", {}).get("serverName") == own, f"status.backup.serverName {status.get('backup')} != {own}")
        check(spec["plugins"][0]["parameters"].get("serverName") == own, "a restored cluster archives to a folder of its own")
        check(set(ext) == {own, f"{own}-{RECOVERY}", "restore-source"}, f"externalClusters {sorted(ext)}")
        check(spec["replica"]["self"] == own == spec["replica"]["primary"], f"replica {spec['replica']}")
        replica = live("recovery-cluster")["spec"]
        check(replica["bootstrap"] == {"recovery": {"source": own}}, f"the replica cluster starts from {own}: {replica['bootstrap']}")
        check(replica["plugins"][0]["parameters"]["serverName"] == f"{own}-{RECOVERY}", "replica cluster folder")
        check("recovery-restore-objectstore" not in composed, "only the protected site restores")
        check(store["configuration"]["destinationPath"] == "s3://vault-backups-0f3a/barman"
              and store["configuration"]["s3Credentials"]["accessKeyId"]["name"] == f"{name}-backup-s3",
              f"restore store not on the Project's bucket: {store}")
        if state == "empty":
            check(status.get("message", "").startswith(f"Restoring {name} from backup folder secrets-db (up to 2026-10-08T09:30:00Z)"),
                  f"message {status.get('message')}")
    else:
        check("plugins" not in spec and "replica" not in spec, "no backups, no topology: nothing to archive")
        check(set(ext) == {"restore-source"}, f"externalClusters {sorted(ext)}")
        cfg = store["configuration"]
        check(cfg["destinationPath"] == restore["source"]["destinationPath"] and cfg["endpointURL"] == restore["source"]["endpointURL"]
              and cfg["s3Credentials"]["secretAccessKey"] == {"name": "ledger-db-s3", "key": "ACCESS_SECRET_KEY"},
              f"restore store {cfg}")
        check("backupStore" not in status and "backup" not in status, f"no backups: {status}")
        if state == "empty":
            check("from backup folder ledger-db (latest state)" in status.get("message", ""), f"message {status.get('message')}")

check(status.get("endpoints", {}).get("readWrite") == f"{name}-rw.{ns}.svc", "endpoints.readWrite")
check(status.get("secrets", {}).get("app") == f"{name}-app", "secrets.app")

if case == "bare":
    spec = live("cluster")["spec"]
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
    rules = live("prometheusrule")["spec"]["groups"][0]["rules"]
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
