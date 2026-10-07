# Dependencies

Everything the platform needs in the cluster before
[`01-operator/`](../01-operator/) and
[`02-crossplane-api/`](../02-crossplane-api/) are installed, plus a
Prometheus and Grafana in the `demo` namespace.

| Component | Needed for | Required |
|---|---|---|
| cert-manager | barman-cloud backup plugin | yes, unless `INSTALL_BARMAN=false` |
| Prometheus Operator | `PodMonitor` / `PrometheusRule` per PostgresCluster | for monitoring |
| grafana-operator | `GrafanaDashboard` per PostgresCluster | for dashboards |
| HAProxy Ingress | reaching Grafana from outside the cluster | optional |

Install them in the order below.

## 1. cert-manager

```sh
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.21.2/cert-manager.yaml
kubectl -n cert-manager rollout status deploy/cert-manager-webhook
```

## 2. Prometheus Operator

`kube-prometheus-stack` is the community chart for the operator. The flags
turn off its own Prometheus, Alertmanager and Grafana. They keep
kube-state-metrics and node-exporter, which the CNPG dashboard's
CPU/memory panels need.

```sh
helm upgrade -i prometheus-operator kube-prometheus-stack \
  --repo https://prometheus-community.github.io/helm-charts \
  --version 89.2.0 -n prometheus-operator-system --create-namespace \
  --set prometheus.enabled=false \
  --set alertmanager.enabled=false \
  --set grafana.enabled=false
```

Verify:

```sh
kubectl get pods -n prometheus-operator-system
kubectl get crd prometheuses.monitoring.coreos.com
```

## 3. grafana-operator

```sh
helm upgrade -i grafana-operator grafana-operator \
  --repo https://grafana.github.io/helm-charts \
  --version 5.25.0 -n grafana-operator-system --create-namespace
```

Verify:

```sh
kubectl get pods -n grafana-operator-system
kubectl get crd grafanas.grafana.integreatly.org
```

> **Use the HTTP repo above, not `oci://ghcr.io/grafana/helm-charts/...`.**
> For OCI charts, Helm uses the credentials in `~/.docker/config.json`. If
> that file has an expired or under-scoped `ghcr.io` login, ghcr rejects the
> pull with `403: denied`, even though the chart is public. To use OCI
> anyway, run `docker logout ghcr.io` (or `helm registry logout ghcr.io`)
> first.

## 4. HAProxy Ingress (optional)

You need this only to reach Grafana from outside the cluster. Any
`networking.k8s.io/v1` ingress controller works.

```sh
helm upgrade -i haproxy-ingress kubernetes-ingress \
  --repo https://haproxytech.github.io/helm-charts \
  --version 1.54.0 -n haproxy-ingress --create-namespace \
  --set controller.ingressClassResource.default=true \
  --set controller.service.type=LoadBalancer
```

The chart's default Service type is `NodePort`. Set it to `LoadBalancer`
explicitly to get a public IP. On SKE the cloud provider assigns it, so
MetalLB isn't needed.

```sh
kubectl get svc -n haproxy-ingress   # EXTERNAL-IP is where ingress hosts must resolve to
```

## 5. Prometheus and Grafana in `demo`

[`demo/prometheus.yaml`](demo/prometheus.yaml) sets up Prometheus in `demo`:
- It scrapes every `PodMonitor` and `PrometheusRule` in `demo`, which a
  PostgresCluster creates.
- It also scrapes the kubelet/cAdvisor, kube-state-metrics and node-exporter
  `ServiceMonitor`s from step 2.
- It comes with a `ClusterRole` that lets it reach those cluster-wide targets.

[`demo/grafana.yaml`](demo/grafana.yaml) sets up Grafana in `demo`:
- It has a `prometheus` datasource and anonymous Viewer access.
- `allow_embedding` is on, so the Backstage portal can show the dashboards
  in an iframe.
- It carries the label `dashboards.paas.cncp.nl/scope=demo`, which matches
  the default `instanceSelector` on each PostgresCluster's
  `GrafanaDashboard`.

```sh
kubectl create namespace demo --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f demo/
```

Grafana's ingress host is set to `grafana-demo.<haproxy-ip>.nip.io`. Edit it
in `demo/grafana.yaml` for a different cluster, or remove `spec.ingress` and
use a port-forward instead.

Verify:

```sh
kubectl -n demo get prometheus,grafana,grafanadatasource,grafanadashboard
kubectl -n demo port-forward svc/prometheus-operated 9090   # Status > Targets: CNPG pods, kubelet, kube-state-metrics up
kubectl -n demo get secret grafana-admin-credentials -o jsonpath='{.data.GF_SECURITY_ADMIN_PASSWORD}' | base64 -d; echo
```

To embed the dashboards in the portal, point it at this Grafana.
`{namespace}` is replaced with each cluster's namespace:

```sh
export CNPG_GRAFANA_URL='http://grafana-{namespace}.188.34.124.213.nip.io'
```

For another namespace, copy both files and replace every `demo`. The
`ClusterRole` and `ClusterRoleBinding` names are cluster-scoped, so rename
those too.
