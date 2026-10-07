# Installing the Dependency Operators


## cert-manager

Install this first if you plan to use `LokiInstance` — the Loki Operator's
`community` overlay further down needs cert-manager running before it's
applied. None of this project's other dependencies need it.

```sh
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/latest/download/cert-manager.yaml
```

Verify:

```sh
kubectl get pods -n cert-manager
```

## grafana-operator (for `GrafanaInstance`)

```sh
helm upgrade -i grafana-operator \
  oci://ghcr.io/grafana/helm-charts/grafana-operator \
  --version 5.25.0 -n grafana-operator-system --create-namespace
```

Verify:

```sh
kubectl get pods -n grafana-operator-system
kubectl get crd grafanas.grafana.integreatly.org
```

Manifest fallback (no Helm): see the [grafana-operator Kustomize
guide](https://grafana.github.io/grafana-operator/docs/installation/kustomize/),
or `kubectl apply -k github.com/grafana/grafana-operator/config/default?ref=v5.25.0`.
`external-crds/crd-grafana-v5.25.0.yaml` is the CRD this operator was
built and tested against — the Helm chart above installs the matching
`5.25.0` version.


## Prometheus Operator (for `PrometheusInstance`)

```sh
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
helm upgrade --install prometheus-operator prometheus-community/kube-prometheus-stack \
  --version 89.2.0 -n prometheus-operator-system --create-namespace \
  --set prometheus.enabled=false \
  --set alertmanager.enabled=false \
  --set grafana.enabled=false \
  --set kubeStateMetrics.enabled=true \
  --set nodeExporter.enabled=true
```

`kube-prometheus-stack` is the community-maintained chart for the
Prometheus Operator itself — there's no separate lean "operator-only"
chart — so the flags above turn off everything this operator doesn't need
(the stack's own default Prometheus/Alertmanager, Grafana, and the
exporters), leaving just the operator and its CRDs.

Verify:

```sh
kubectl get pods -n prometheus-operator-system
kubectl get crd prometheuses.monitoring.coreos.com
```

Manifest fallback (no Helm):

```sh
kubectl apply --server-side -f \
  https://raw.githubusercontent.com/prometheus-operator/prometheus-operator/v0.93.1/bundle.yaml
```

`external-crds/crd-prometheus-operator-v0.93.1.yaml` is the CRD this
operator was built and tested against — both routes above install the
matching `0.93.1` release (`kube-prometheus-stack` `89.2.0` pins
`appVersion: v0.93.1`).

**Container-level (CPU/memory/IO) panels on the CNPG and Kafka Grafana
dashboards need more than the above.** The MariaDB, RabbitMQ, and MongoDB
dashboards are self-contained — every panel reads from that workload's own
exporter (`mysqld_exporter`, RabbitMQ's exporter, `mongodb_exporter`), reached
through a `PodMonitor`/`ServiceMonitor` the owning operator creates in the
same namespace as the `PrometheusInstance`. The CNPG and Strimzi Kafka
dashboards instead source their utilization panels from cluster-wide
infrastructure metrics — `container_cpu_usage_seconds_total` /
`container_memory_working_set_bytes` (kubelet cAdvisor) and
`kube_pod_container_resource_requests` / `kube_pod_container_status_ready`
(kube-state-metrics) — which this project has no operator-owned path to.
`kubeStateMetrics.enabled=true`/`nodeExporter.enabled=true` above do deploy
kube-state-metrics and node-exporter, but two things still have to be true
before those panels populate:

- Their `ServiceMonitor`s (created by the chart, one in its own release
  namespace for kube-state-metrics, one wherever `kubelet.namespace` points —
  `kube-system` by default) must be visible to the `PrometheusInstance`
  actually scraping the workload. `internal/prometheus` deliberately leaves
  `serviceMonitorNamespaceSelector`/`podMonitorNamespaceSelector` unset (see
  its package doc and Scope above), so a generated Prometheus only discovers
  `ServiceMonitor`/`PodMonitor` objects in its *own* namespace. Simplest fix:
  create the `PrometheusInstance` in `prometheus-operator-system` itself. To
  keep it elsewhere, copy each `ServiceMonitor` into that namespace instead,
  pointing `spec.namespaceSelector` back at wherever its target Service
  actually lives.

- Scraping the kubelet's `/metrics/cadvisor` endpoint needs cluster-scoped
  RBAC (`nodes/metrics`, `nodes/proxy`, `nodes/stats`) that this operator does
  not grant — `scrapeRBACExtras` in `internal/prometheus` only creates a
  namespace-scoped `Role` on `pods`/`services`/`endpoints`. Grant it
  separately, against each `PrometheusInstance`'s own ServiceAccount (named
  after the `PrometheusInstance`).

  `hack/promsetup.sh` handles both of the above: it reads the target
  namespace from the current kubectl context, finds the real
  kube-state-metrics/kubelet `ServiceMonitor`s cluster-wide (no dependency on
  chart version or release name) and copies each one that isn't already
  visible, then creates the `nodes/metrics`/`nodes/proxy`/`nodes/stats`
  `ClusterRole` and binds it to every `PrometheusInstance` found in that
  namespace:

  ```sh
  ./promsetup.sh
  ```

## Alloy Operator (for `AlloyInstance`)

```sh
helm upgrade -i alloy-operator alloy-operator \
  --repo https://grafana.github.io/helm-charts \
  --version 0.7.1 -n alloy-operator-system --create-namespace
```

Verify:

```sh
kubectl get pods -n alloy-operator-system
kubectl get crd alloys.collectors.grafana.com
```

`external-crds/crd-alloy-operator-v0.7.1.yaml` is the CRD this operator was
built and tested against, matching Alloy Operator `v0.7.1` (which embeds
Alloy `v1.19.2`) — if you install a different version, double-check
`internal/alloy`'s field paths (`spec.alloy.configMap.content`,
`spec.controller.type`/`spec.controller.replicas`, `spec.rbac.namespaces`)
still match the `grafana/alloy` Helm chart values schema that version
embeds.

If the cluster already runs its own Alloy or Promtail for some other,
unrelated purpose (a platform-wide log pipeline shipping to a hosted Loki
outside this cluster, say), this is independent of it: each `AlloyInstance`
only ever reads pods in its own namespace (`spec.rbac.namespaces`) and only
ever pushes to its own `spec.lokiInstanceRef`'s distributor, so the two
never collide or double-ship the same logs to the same place.

## Ingress controller (optional, for `spec.ingress`)

`GrafanaInstance`, `RabbitMQCluster`, and `PrometheusInstance` all share the
same `IngressSpec` (`spec.ingress.host`, optional `ingressClassName`,
`tlsSecretName`, `annotations`) -- a real, standard
`networking.k8s.io/v1 Ingress`, not a vendor-specific CRD or a Gateway API
`HTTPRoute` (this project doesn't use the Gateway API anywhere). For Grafana
it's applied directly as the underlying `Grafana`'s own `spec.ingress`
(grafana-operator creates and owns the resulting `Ingress` object itself,
but mirrors `Grafana.spec.ingress.spec` onto it verbatim -- it does *not*
fill in the backend automatically, so `internal/grafana`'s `BuildManifest`
routes the rule at grafana-operator's own generated Service itself, the
same way `internal/ingress` does explicitly for RabbitMQ/Prometheus, which
have no native ingress field of their own at all).
See each type's own doc comment in `api/v1alpha1/` for details.

An `Ingress` object is just routing intent, though -- nothing serves it
without an ingress controller watching the cluster and an `IngressClass` for
`ingressClassName` to select (or the cluster's default one, if
`ingressClassName` is left unset). If none is installed yet,
[HAProxy Ingress](https://github.com/haproxytech/kubernetes-ingress)
(HAProxy Technologies' own controller -- any `networking.k8s.io/v1`-conformant
controller works here, since `IngressSpec` builds a plain standard
`Ingress`) is a solid choice:

```sh
helm upgrade --install haproxy-ingress kubernetes-ingress \
  --repo https://haproxytech.github.io/helm-charts \
  --version 1.54.0 -n haproxy-ingress --create-namespace \
  --set controller.ingressClassResource.default=true \
  --set controller.service.type=LoadBalancer
```

`controller.service.type` defaults to `NodePort` in this chart (confirmed
against `helm show values haproxytech/kubernetes-ingress --version 1.54.0`),
so it does **not** get a `LoadBalancer` Service on its own, even on a
cloud-managed cluster with a working cloud-controller-manager (SKE on
STACKIT included -- no MetalLB needed there, `type: LoadBalancer` Services
get a real external IP from the cloud provider directly). Left at the
default, the controller gets no public IP at all, and every `Ingress`'s
`.status.loadBalancer.ingress` (its `ADDRESS` column in `kubectl get
ingress`) ends up mirroring the controller Service's internal ClusterIP
instead, via its `--publish-service` flag -- not reachable from outside the
cluster. Pass `--set controller.service.type=LoadBalancer` explicitly, as
above, to get a real public IP.

Verify:

```sh
kubectl get pods -n haproxy-ingress
kubectl get ingressclass
kubectl get svc -n haproxy-ingress   # EXTERNAL-IP is the address every spec.ingress.host should point its DNS record at
```

The chart registers an `IngressClass` named `haproxy`; by default it does
*not* mark it as the cluster's default (`--set
controller.ingressClassResource.default=true` above turns that on).