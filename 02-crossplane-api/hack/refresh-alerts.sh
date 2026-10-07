#!/usr/bin/env bash
# Re-renders ../src/alerts/cnpg-cluster-rules.yaml from the upstream
# cnpg/cluster Helm chart's PrometheusRule, with placeholder names that
# generate.py later swaps for template expressions. Run, review the diff,
# then `make generate`.
#
#   CLUSTER_CHART_VERSION=0.9.0 hack/refresh-alerts.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${SCRIPT_DIR}/../src/alerts/cnpg-cluster-rules.yaml"
CLUSTER_CHART_VERSION="${CLUSTER_CHART_VERSION:-}"

helm repo add cnpg https://cloudnative-pg.github.io/charts >/dev/null 2>&1 || true
helm repo update cnpg >/dev/null

tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

helm pull cnpg/cluster ${CLUSTER_CHART_VERSION:+--version "${CLUSTER_CHART_VERSION}"} --untar --untardir "${tmp}"
version="$(grep '^version:' "${tmp}/cluster/Chart.yaml" | awk '{print $2}')"

helm template xrel "${tmp}/cluster" -n zznamespacezz \
  --set fullnameOverride=zzclusterzz \
  --set cluster.monitoring.enabled=true \
  --set cluster.monitoring.prometheusRule.enabled=true \
  --show-only templates/prometheus-rule.yaml > "${tmp}/rule.yaml"

python3 -I - "${tmp}/rule.yaml" "${OUT}" "${version}" <<'EOF'
import sys, yaml

src, out, version = sys.argv[1:4]
rules = yaml.safe_load(open(src))["spec"]["groups"][0]["rules"]
for r in rules:
    # Helm-specific labels that would only confuse alert routing.
    for k in [k for k in r.get("labels", {}) if k.startswith(("app.kubernetes.io/", "helm.sh/"))]:
        del r["labels"][k]

class Dumper(yaml.SafeDumper):
    pass

def str_presenter(dumper, data):
    style = "|" if "\n" in data else None
    return dumper.represent_scalar("tag:yaml.org,2002:str", data, style=style)

Dumper.add_representer(str, str_presenter)

header = f"""# CloudNativePG alert rules, rendered from the upstream cnpg/cluster Helm
# chart {version} (Apache-2.0, https://github.com/cloudnative-pg/charts) by
# hack/refresh-alerts.sh -- do not edit by hand. generate.py substitutes:
#   zzclusterzz   -> the PostgresCluster name
#   zznamespacezz -> the PostgresCluster namespace
# and escapes Prometheus' own {{{{ $value }}}} / {{{{ $labels.x }}}} templating
# so function-go-templating passes it through untouched.
"""
with open(out, "w") as f:
    f.write(header)
    yaml.dump(rules, f, Dumper=Dumper, sort_keys=False, width=1000)
print(f"wrote {len(rules)} rules from cnpg/cluster {version} to {out}")
EOF
