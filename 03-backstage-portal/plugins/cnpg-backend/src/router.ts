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
} from '@internal/backstage-plugin-cnpg-common';
import { CnpgKubernetesService } from './service/CnpgKubernetesService';
import { summarize } from '@internal/backstage-plugin-cnpg-common';

// DNS-1123 label, short enough that CNPG's derived names (<name>-pooler-rw,
// <name>-1, ...) stay within Kubernetes' limits.
const NAME = /^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$/;
const name = z.string().regex(NAME, 'lowercase letters, digits and "-", max 40 characters');
const namespace = z.string().regex(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/, 'invalid namespace');
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
    const items = await k8s.list(ns);
    res.json({ items: items.map(summarize) });
  });

  router.get('/clusters/:namespace/:name', async (req, res) => {
    await authorize(req, cnpgClusterReadPermission);
    const p = params(req);
    res.json(await k8s.details(p.namespace, p.name));
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

  router.delete('/clusters/:namespace/:name', async (req, res) => {
    await authorize(req, cnpgClusterDeletePermission);
    const p = params(req);
    await k8s.delete(p.namespace, p.name);
    res.status(202).json({ status: 'deleting' });
  });

  return router;
}
