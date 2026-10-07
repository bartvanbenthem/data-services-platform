import {
  HttpAuthService,
  PermissionsService,
  RootConfigService,
} from '@backstage/backend-plugin-api';
import { InputError, NotAllowedError } from '@backstage/errors';
import {
  AuthorizeResult,
  BasicPermission,
} from '@backstage/plugin-permission-common';
import express from 'express';
import Router from 'express-promise-router';
import { z } from 'zod/v3';
import {
  cnpgClusterCreatePermission,
  cnpgClusterDeletePermission,
  cnpgClusterReadPermission,
  cnpgClusterUpdatePermission,
  cnpgProjectCreatePermission,
  cnpgProjectReadPermission,
  cnpgProjectUpdatePermission,
  Project,
  PostgresClusterSummary,
  summarize,
  summarizeProject,
} from '@internal/backstage-plugin-cnpg-common';
import { CnpgKubernetesService } from './service/CnpgKubernetesService';

// DNS-1123 label, short enough that CNPG's derived names (<name>-pooler-rw,
// <name>-1, ...) stay within Kubernetes' limits.
const NAME = /^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$/;
const name = z.string().regex(NAME, 'lowercase letters, digits and "-", max 40 characters');
const namespace = z.string().regex(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/, 'invalid project');
const labelValue = z.string().regex(/^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$/).max(63);

const createSchema = z.object({
  name,
  namespace,
  /** Passed through to the XR; validated by the API server against the XRD. */
  spec: z.record(z.unknown()),
  owner: labelValue.optional(),
  dryRun: z.boolean().optional(),
});

const updateSchema = z.object({
  spec: z.record(z.unknown()),
});

/**
 * A JSON merge patch of the spec: only the fields present change, null
 * removes one. The XRD decides what may change on a live object.
 */
const patchSchema = z.object({
  spec: z.record(z.unknown()),
  /** New catalog owner; null removes it. */
  owner: labelValue.nullable().optional(),
  dryRun: z.boolean().optional(),
});

const ownerLabel = (owner: string | null | undefined) =>
  owner === undefined ? undefined : { 'backstage.io/owner': owner || null };

const createProjectSchema = z.object({
  // Also the namespace name; the XRD enforces the same rules.
  name: name.refine(v => !v.includes('--'), 'must not contain "--"'),
  owner: labelValue.optional(),
  description: z.string().max(200).optional(),
  /** Passed through to the XR; validated by the API server against the XRD. */
  spec: z.record(z.unknown()).optional(),
  dryRun: z.boolean().optional(),
});

/** Adds the cluster's Project (same name as its namespace) and that project's Grafana. */
function withProject(
  summary: PostgresClusterSummary,
  project: Project | undefined,
): PostgresClusterSummary {
  if (!project) return summary;
  return {
    ...summary,
    project: project.metadata.name,
    grafanaUrl: project.status?.grafana?.url || undefined,
  };
}

export async function createRouter(options: {
  httpAuth: HttpAuthService;
  permissions: PermissionsService;
  config: RootConfigService;
  k8s: CnpgKubernetesService;
}): Promise<express.Router> {
  const { httpAuth, permissions, config, k8s } = options;
  const router = Router();
  router.use(express.json());

  const authorize = async (req: express.Request, permission: BasicPermission) => {
    const credentials = await httpAuth.credentials(req);
    const [decision] = await permissions.authorize([{ permission }], { credentials });
    if (decision.result !== AuthorizeResult.ALLOW) {
      throw new NotAllowedError(`Missing permission ${permission.name}`);
    }
  };

  const params = (req: express.Request) => {
    const parsed = z.object({ namespace, name }).safeParse(req.params);
    if (!parsed.success) throw new InputError(parsed.error.toString());
    return parsed.data;
  };

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Static settings the UI needs (Grafana link target, form defaults).
  router.get('/config', async (req, res) => {
    await authorize(req, cnpgClusterReadPermission);
    res.json({
      grafanaUrl: config.getOptionalString('cnpg.grafanaUrl'),
      defaultNamespace: config.getOptionalString('cnpg.defaultNamespace'),
      storageClasses: config.getOptionalStringArray('cnpg.storageClasses') ?? [],
    });
  });

  router.get('/namespaces', async (req, res) => {
    await authorize(req, cnpgClusterReadPermission);
    res.json({ items: await k8s.namespaces() });
  });

  router.get('/clusters', async (req, res) => {
    await authorize(req, cnpgClusterReadPermission);
    const ns = typeof req.query.namespace === 'string' ? req.query.namespace : undefined;
    const [items, projects] = await Promise.all([k8s.list(ns), k8s.listProjects()]);
    const byName = new Map(projects.map(p => [p.metadata.name, p]));
    res.json({ items: items.map(c => withProject(summarize(c), byName.get(c.metadata.namespace))) });
  });

  router.get('/clusters/:namespace/:name', async (req, res) => {
    await authorize(req, cnpgClusterReadPermission);
    const p = params(req);
    const [details, project] = await Promise.all([
      k8s.details(p.namespace, p.name),
      // Not a project namespace, or no Project API: no project info.
      k8s.getProject(p.namespace).catch(() => undefined),
    ]);
    res.json({ ...details, summary: withProject(details.summary, project) });
  });

  router.get('/projects', async (req, res) => {
    await authorize(req, cnpgProjectReadPermission);
    const items = await k8s.listProjects();
    res.json({
      items: items.map(summarizeProject).sort((a, b) => a.name.localeCompare(b.name)),
    });
  });

  router.get('/projects/:name', async (req, res) => {
    await authorize(req, cnpgProjectReadPermission);
    const parsed = z.object({ name }).safeParse(req.params);
    if (!parsed.success) throw new InputError(parsed.error.toString());
    const resource = await k8s.getProject(parsed.data.name);
    res.json({ summary: summarizeProject(resource), resource });
  });

  router.post('/projects', async (req, res) => {
    await authorize(req, cnpgProjectCreatePermission);
    const parsed = createProjectSchema.safeParse(req.body);
    if (!parsed.success) throw new InputError(parsed.error.toString());
    const { name: projectName, owner, description, spec, dryRun } = parsed.data;
    const created = await k8s.applyProject({
      name: projectName,
      spec: {
        ...spec,
        ...(owner ? { owner } : {}),
        ...(description ? { description } : {}),
      },
      labels: owner ? { 'backstage.io/owner': owner } : undefined,
      createOnly: true,
      dryRun,
    });
    res.status(dryRun ? 200 : 201).json(created);
  });

  router.patch('/projects/:name', async (req, res) => {
    await authorize(req, cnpgProjectUpdatePermission);
    const p = z.object({ name }).safeParse(req.params);
    if (!p.success) throw new InputError(p.error.toString());
    const parsed = patchSchema.omit({ owner: true }).safeParse(req.body);
    if (!parsed.success) throw new InputError(parsed.error.toString());
    const { spec, dryRun } = parsed.data;
    // The owner lives in the spec and, for the catalog, in a label; keep both in step.
    let owner: string | null | undefined;
    if ('owner' in spec) {
      const o = labelValue.nullable().safeParse(spec.owner || null);
      if (!o.success) throw new InputError(`owner: ${o.error.issues[0]?.message}`);
      owner = o.data;
      spec.owner = owner;
    }
    res.json(
      await k8s.patchProject({ name: p.data.name, spec, labels: ownerLabel(owner), dryRun }),
    );
  });

  router.post('/clusters', async (req, res) => {
    await authorize(req, cnpgClusterCreatePermission);
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new InputError(parsed.error.toString());
    const { owner, ...rest } = parsed.data;
    const created = await k8s.apply({
      ...rest,
      labels: owner ? { 'backstage.io/owner': owner } : undefined,
      createOnly: true,
    });
    res.status(parsed.data.dryRun ? 200 : 201).json(created);
  });

  router.put('/clusters/:namespace/:name', async (req, res) => {
    await authorize(req, cnpgClusterUpdatePermission);
    const p = params(req);
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) throw new InputError(parsed.error.toString());
    const existing = await k8s.get(p.namespace, p.name);
    const owner = existing.metadata.labels?.['backstage.io/owner'];
    res.json(
      await k8s.apply({
        ...p,
        spec: parsed.data.spec,
        labels: owner ? { 'backstage.io/owner': owner } : undefined,
      }),
    );
  });

  router.patch('/clusters/:namespace/:name', async (req, res) => {
    await authorize(req, cnpgClusterUpdatePermission);
    const p = params(req);
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) throw new InputError(parsed.error.toString());
    const { spec, owner, dryRun } = parsed.data;
    res.json(await k8s.patch({ ...p, spec, labels: ownerLabel(owner), dryRun }));
  });

  router.delete('/clusters/:namespace/:name', async (req, res) => {
    await authorize(req, cnpgClusterDeletePermission);
    const p = params(req);
    await k8s.delete(p.namespace, p.name);
    res.status(202).json({ status: 'deleting' });
  });

  return router;
}
