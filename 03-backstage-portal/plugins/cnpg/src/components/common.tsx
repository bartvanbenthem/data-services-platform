import { Alert, Flex, Text } from '@backstage/ui';
import type { PostgresClusterSummary } from '@internal/backstage-plugin-cnpg-common';
import { ReactNode } from 'react';

/** Database glyph used for the nav item and the entity tab. */
export const PostgresIcon = () => (
  <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
    <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
  </svg>
);

export type Health = 'healthy' | 'progressing' | 'degraded' | 'deleting';

/**
 * One word for the state of a cluster, combining Crossplane's Ready
 * condition (every composed object exists, Cluster healthy) with CNPG's
 * instance counts.
 */
export function health(c: PostgresClusterSummary): Health {
  if (c.deleting) return 'deleting';
  if (c.ready) return 'healthy';
  if (c.readyInstances > 0 && c.readyInstances < c.instances) return 'degraded';
  return 'progressing';
}

const HEALTH: Record<Health, { label: string; color: string }> = {
  healthy: { label: 'Healthy', color: 'var(--bui-fg-positive, #1f883d)' },
  progressing: { label: 'Provisioning', color: 'var(--bui-fg-info, #0969da)' },
  degraded: { label: 'Degraded', color: 'var(--bui-fg-warning, #9a6700)' },
  deleting: { label: 'Deleting', color: 'var(--bui-fg-secondary, #59636e)' },
};

export const HealthBadge = ({ cluster }: { cluster: PostgresClusterSummary }) => {
  const { label, color } = HEALTH[health(cluster)];
  return (
    <Flex align="center" gap="1">
      <span
        aria-hidden="true"
        style={{ width: 8, height: 8, borderRadius: '50%', background: color, flex: 'none' }}
      />
      <Text variant="body-small">{label}</Text>
    </Flex>
  );
};

export function age(timestamp?: string): string {
  if (!timestamp) return '-';
  const seconds = Math.max(0, (Date.now() - new Date(timestamp).getTime()) / 1000);
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export type TimeRange = '1h' | '6h' | '24h' | '7d';

/**
 * URL of a cluster's CNPG dashboard. `grafanaUrl` may contain "{namespace}"
 * for setups with one Grafana per namespace. With `embed`, Grafana's chrome is
 * hidden (kiosk) and the dark theme matches the portal.
 */
export function grafanaLink(
  grafanaUrl: string | undefined,
  uid: string | undefined,
  opts: { namespace?: string; cluster?: string; embed?: boolean; range?: TimeRange } = {},
): string | undefined {
  if (!grafanaUrl || !uid) return undefined;
  const base = grafanaUrl.replace(/\{namespace\}/g, opts.namespace ?? '').replace(/\/$/, '');
  const params = new URLSearchParams();
  if (opts.namespace) params.set('var-namespace', opts.namespace);
  if (opts.cluster) params.set('var-cluster', opts.cluster);
  if (opts.range) {
    params.set('from', `now-${opts.range}`);
    params.set('to', 'now');
  }
  if (opts.embed) {
    params.set('theme', 'dark');
    params.set('refresh', '30s');
  }
  // Bare flags: kiosk hides Grafana's chrome; the _dash.* flags (Grafana 11.3+)
  // hide the time picker and variables, which the portal already controls.
  const flags = opts.embed ? '&kiosk&_dash.hideTimePicker&_dash.hideVariables&_dash.hideLinks' : '';
  const query = params.toString() + flags;
  return `${base}/d/${encodeURIComponent(uid)}${query ? `?${query.replace(/^&/, '')}` : ''}`;
}

export const ErrorAlert = ({ error }: { error: Error }) => (
  <Alert status="danger" title="Request failed" description={error.message} />
);

/** Label/value rows inside a card. */
export const Fields = ({ rows }: { rows: Array<[string, ReactNode]> }) => (
  <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '8px 24px', margin: 0 }}>
    {rows.map(([label, value]) => (
      <div key={label} style={{ display: 'contents' }}>
        <dt>
          <Text variant="body-small" color="secondary">{label}</Text>
        </dt>
        <dd style={{ margin: 0, minWidth: 0, overflowWrap: 'anywhere' }}>
          {typeof value === 'string' || typeof value === 'number' ? (
            <Text variant="body-small">{value}</Text>
          ) : (
            value
          )}
        </dd>
      </div>
    ))}
  </dl>
);

export const Mono = ({ children }: { children: ReactNode }) => (
  <code style={{ fontFamily: 'var(--bui-font-monospace, monospace)', fontSize: '0.85em' }}>{children}</code>
);
