#!/usr/bin/env bash
# Copies the kube-state-metrics and kubelet ServiceMonitors (wherever
# kube-prometheus-stack actually put them) into the current kubectl
# context's namespace, so a PrometheusInstance living there can discover
# them despite internal/prometheus's namespace-scoped selectors, and grants
# the cluster-scoped RBAC each PrometheusInstance in that namespace needs to
# scrape the kubelet's /metrics/cadvisor endpoint. See the "Prometheus
# Operator" section of the README for background.
set -euo pipefail

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

TARGET_NS=$(kubectl config view --minify -o jsonpath='{..namespace}')
TARGET_NS=${TARGET_NS:-default}

find_servicemonitor() {
  # Excludes names ending in "-copy" so a previous run of this script never
  # gets mistaken for the original -- e.g. "kubelet" also matches this
  # script's own "prometheus-operator-kube-p-kubelet-copy" output, which
  # would otherwise make a re-run treat an already-(possibly wrong)-copied
  # ServiceMonitor as the source and skip fixing it.
  kubectl get servicemonitor -A -o json | jq -r --arg pattern "$1" '
    .items[] | select((.metadata.name | test($pattern)) and (.metadata.name | test("-copy$") | not))
    | "\(.metadata.namespace)/\(.metadata.name)"
  ' | head -n1
}

KSM_SM=$(find_servicemonitor 'kube-state-metrics')
KUBELET_SM=$(find_servicemonitor 'kubelet')

for src in "$KSM_SM" "$KUBELET_SM"; do
  if [[ -z "$src" ]]; then
    echo "warning: no matching ServiceMonitor found, skipping" >&2
    continue
  fi

  SRC_NS=${src%%/*}
  SRC_NAME=${src#*/}

  if [[ "$SRC_NS" == "$TARGET_NS" ]]; then
    echo "skipping $src: already in $TARGET_NS"
    continue
  fi

  # Deliberately leaves spec.namespaceSelector untouched: it already points
  # at wherever the ServiceMonitor's *target* Service actually lives (e.g.
  # kube-prometheus-stack's kubelet ServiceMonitor sets it to "kube-system",
  # not to the namespace the ServiceMonitor object itself resides in) --
  # overwriting it with $SRC_NS previously broke the kubelet copy, since the
  # kubelet ServiceMonitor object lives in the chart's release namespace but
  # its target Service lives in kube-system.
  kubectl get servicemonitor -n "$SRC_NS" "$SRC_NAME" -o json | jq \
    --arg ns "$TARGET_NS" '
      .metadata.namespace = $ns
      | .metadata.name += "-copy"
      | del(.metadata.uid, .metadata.resourceVersion, .metadata.creationTimestamp,
            .metadata.generation, .metadata.ownerReferences, .metadata.selfLink, .status)
    ' | kubectl apply -f -
done

# internal/prometheus's scrapeRBACExtras only grants a namespace-scoped Role
# on pods/services/endpoints (scoped to the PrometheusInstance's own
# namespace), so two things need a separate cluster-scoped grant, bound to
# each PrometheusInstance's ServiceAccount:
#   - the kubelet's /metrics/cadvisor endpoint itself (nodes/metrics,
#     nodes/proxy, nodes/stats)
#   - discovering the copied ServiceMonitors' actual targets, since their
#     Services/Endpoints/Pods live in kube-system and the kube-prometheus-stack
#     release namespace, not in $TARGET_NS
# That ServiceAccount is always named after the PrometheusInstance itself
# (internal/prometheus sets serviceAccountName == cr.GetName()), so it can be
# derived without touching any status field.
PI_NAMES=$(kubectl get prometheusinstance -n "$TARGET_NS" -o jsonpath='{.items[*].metadata.name}' 2>/dev/null || true)

if [[ -z "$PI_NAMES" ]]; then
  echo "warning: no PrometheusInstance found in $TARGET_NS, skipping kubelet cAdvisor RBAC" >&2
else
  kubectl apply -f - <<'EOF'
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: prometheusinstance-kubelet-cadvisor
rules:
- apiGroups: [""]
  resources: ["nodes/metrics", "nodes/proxy", "nodes/stats"]
  verbs: ["get"]
- apiGroups: [""]
  resources: ["pods", "services", "endpoints"]
  verbs: ["get", "list", "watch"]
EOF

  for PI_NAME in $PI_NAMES; do
    kubectl create clusterrolebinding "${PI_NAME}-kubelet-cadvisor" \
      --clusterrole=prometheusinstance-kubelet-cadvisor \
      --serviceaccount="${TARGET_NS}:${PI_NAME}" \
      --dry-run=client -o yaml | kubectl apply -f -
  done
fi
