import { useApi, useRouteRef } from '@backstage/frontend-plugin-api';
import { usePermission } from '@backstage/plugin-permission-react';
import { Alert, ButtonLink, Container, Flex, Grid, Header } from '@backstage/ui';
import { cnpgProjectCreatePermission } from '@internal/backstage-plugin-cnpg-common';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import useAsync from 'react-use/esm/useAsync';
import { stringify } from 'yaml';
import { cnpgApiRef } from '../api';
import { clusterRouteRef, createProjectRouteRef } from '../routes';
import { ClusterFormFields } from './ClusterFormFields';
import { ManifestPanel } from './common';
import { ClusterForm, defaultForm, toManifest, toSpec, validate } from './form';

export const CreateClusterPage = () => {
  const api = useApi(cnpgApiRef);
  const navigate = useNavigate();
  const clusterLink = useRouteRef(clusterRouteRef);
  const createProjectLink = useRouteRef(createProjectRouteRef);
  const { allowed: canCreateProject } = usePermission({ permission: cnpgProjectCreatePermission });
  const [params] = useSearchParams();

  const { value: config } = useAsync(() => api.getConfig(), [api]);
  // Clusters go into a Project namespace, which comes with its own
  // Prometheus and Grafana; free-text namespaces are no longer offered.
  const { value: projects, loading: projectsLoading } = useAsync(() => api.listProjects(), [api]);

  // ?project=<name> (from a project page) wins over the configured default.
  const [form, setForm] = useState<ClusterForm>(defaultForm(params.get('project') ?? ''));
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState<'validate' | 'create'>();
  const [result, setResult] = useState<{ error?: Error; validated?: boolean }>({});

  useEffect(() => {
    const preferred = config?.defaultNamespace;
    if (preferred && projects?.some(p => p.name === preferred)) {
      setForm(f => (f.namespace ? f : { ...f, namespace: preferred }));
    }
  }, [config, projects]);

  /** Selecting a project also suggests its owner, unless one was typed already. */
  const selectProject = (name: string) => {
    const project = projects?.find(p => p.name === name);
    setForm(f => ({ ...f, namespace: name, owner: f.owner || project?.owner || '' }));
    setResult({});
  };

  const update = (fn: (f: ClusterForm) => ClusterForm) => {
    setForm(fn);
    setResult({});
  };

  const errors = useMemo(() => validate(form), [form]);
  const err = (key: keyof ClusterForm) => (touched ? errors[key] : undefined);
  const manifest = useMemo(() => stringify(toManifest(form)), [form]);

  const submit = async (dryRun: boolean) => {
    setTouched(true);
    if (Object.keys(errors).length) return;
    setSubmitting(dryRun ? 'validate' : 'create');
    setResult({});
    try {
      await api.createCluster({
        name: form.name,
        namespace: form.namespace,
        owner: form.owner || undefined,
        spec: toSpec(form),
        dryRun,
      });
      if (dryRun) {
        setResult({ validated: true });
      } else {
        navigate(clusterLink?.({ namespace: form.namespace, name: form.name }) ?? '/cnpg');
      }
    } catch (e) {
      setResult({ error: e as Error });
    } finally {
      setSubmitting(undefined);
    }
  };

  return (
    <>
      <Header
        title="Create PostgreSQL cluster"
      />
      <Container>
        <Grid.Root columns={{ initial: '1', lg: '3' }} gap="4">
          <Grid.Item colSpan={{ initial: '1', lg: '2' }}>
            <Flex direction="column" gap="4">
              {!projectsLoading && projects?.length === 0 && (
                <Alert
                  status="info"
                  title="No projects yet"
                  description="A cluster lives in a project, which comes with its own Prometheus and Grafana. Create a project first."
                  customActions={
                    canCreateProject && createProjectLink ? (
                      <ButtonLink href={createProjectLink()} variant="secondary" size="small">
                        Create project
                      </ButtonLink>
                    ) : undefined
                  }
                />
              )}
              <ClusterFormFields
                form={form}
                setForm={update}
                err={err}
                storageClasses={config?.storageClasses ?? []}
                projects={projects}
                onSelectProject={selectProject}
              />
            </Flex>
          </Grid.Item>

          <Grid.Item>
            <ManifestPanel
              manifest={manifest}
              hasErrors={touched && Object.keys(errors).length > 0}
              error={result.error}
              validated={result.validated}
              submitting={submitting}
              onSubmit={submit}
              createLabel="Create cluster"
            />
          </Grid.Item>
        </Grid.Root>
      </Container>
    </>
  );
};
