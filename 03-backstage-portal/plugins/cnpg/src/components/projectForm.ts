/**
 * Create-project form state and its mapping onto a Project spec. Like
 * form.ts: only what the form exposes is sent, the rest falls back to the
 * XRD defaults, and the API server has the final say.
 */

export interface ProjectForm {
  name: string;
  owner: string;
  description: string;
  editGroup: string;
  viewGroup: string;
  quotaEnabled: boolean;
  quotaCpu: string;
  quotaMemory: string;
  quotaStorage: string;
  prometheusRetention: string;
  prometheusStorage: string;
  grafanaIngress: boolean;
}

export const defaultProjectForm = (): ProjectForm => ({
  name: '',
  owner: '',
  description: '',
  editGroup: '',
  viewGroup: '',
  quotaEnabled: false,
  quotaCpu: '8',
  quotaMemory: '32Gi',
  quotaStorage: '200Gi',
  prometheusRetention: '7d',
  prometheusStorage: '10Gi',
  grafanaIngress: true,
});

const NAME = /^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$/;
const RESERVED = ['default', 'projects', 'crossplane-system', 'cnpg-system', 'cert-manager'];
const QUANTITY = /^[0-9]+(Mi|Gi|Ti)$/;

/** Field-level errors shown inline; mirrors the XRD's rules. */
export function validateProject(f: ProjectForm): Partial<Record<keyof ProjectForm, string>> {
  const e: Partial<Record<keyof ProjectForm, string>> = {};
  if (!NAME.test(f.name) || f.name.includes('--')) {
    e.name = 'Lowercase letters, digits and single "-", starting with a letter, max 40 characters.';
  } else if (f.name.startsWith('kube-') || RESERVED.includes(f.name)) {
    e.name = 'This name is reserved.';
  }
  if (f.owner && !/^[A-Za-z0-9][-A-Za-z0-9_.]{0,62}$/.test(f.owner)) e.owner = 'A group name, e.g. team-payments.';
  if (f.description.length > 200) e.description = 'At most 200 characters.';
  if (f.quotaEnabled) {
    if (!/^[0-9]+(\.[0-9]+)?m?$/.test(f.quotaCpu)) e.quotaCpu = 'e.g. 8 or 500m';
    if (!QUANTITY.test(f.quotaMemory)) e.quotaMemory = 'e.g. 32Gi';
    if (!QUANTITY.test(f.quotaStorage)) e.quotaStorage = 'e.g. 200Gi';
  }
  if (!/^[0-9]+(h|d|w|y)$/.test(f.prometheusRetention)) e.prometheusRetention = 'e.g. 7d, 2w';
  if (!QUANTITY.test(f.prometheusStorage)) e.prometheusStorage = 'e.g. 10Gi';
  return e;
}

/** The Project spec, without owner/description (sent as their own fields). */
export function toProjectSpec(f: ProjectForm): Record<string, unknown> {
  const access = [
    ...(f.editGroup.trim() ? [{ group: f.editGroup.trim(), role: 'edit' }] : []),
    ...(f.viewGroup.trim() ? [{ group: f.viewGroup.trim(), role: 'view' }] : []),
  ];
  return {
    ...(access.length ? { access } : {}),
    ...(f.quotaEnabled
      ? { quota: { cpu: f.quotaCpu, memory: f.quotaMemory, storage: f.quotaStorage } }
      : {}),
    observability: {
      prometheus: {
        retention: f.prometheusRetention,
        storage: { size: f.prometheusStorage },
      },
      grafana: { ingress: f.grafanaIngress },
    },
  };
}

/** The manifest the form produces, for the preview pane. */
export function toProjectManifest(f: ProjectForm) {
  return {
    apiVersion: 'platform.cncp.nl/v1alpha1',
    kind: 'Project',
    metadata: { name: f.name || '<name>' },
    spec: {
      ...(f.owner ? { owner: f.owner } : {}),
      ...(f.description ? { description: f.description } : {}),
      ...toProjectSpec(f),
    },
  };
}
