import { useApi, useRouteRef } from '@backstage/frontend-plugin-api';
import { Container, Flex, Grid, Header, Switch, TextField } from '@backstage/ui';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { stringify } from 'yaml';
import { cnpgApiRef } from '../api';
import { projectRouteRef } from '../routes';
import { ManifestPanel, Section } from './common';
import {
  defaultProjectForm,
  ProjectForm,
  toProjectManifest,
  toProjectSpec,
  validateProject,
} from './projectForm';

export const CreateProjectPage = () => {
  const api = useApi(cnpgApiRef);
  const navigate = useNavigate();
  const projectLink = useRouteRef(projectRouteRef);

  const [form, setForm] = useState<ProjectForm>(defaultProjectForm());
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState<'validate' | 'create'>();
  const [result, setResult] = useState<{ error?: Error; validated?: boolean }>({});

  const set = <K extends keyof ProjectForm>(key: K) => (value: ProjectForm[K]) => {
    setForm(f => ({ ...f, [key]: value }));
    setResult({});
  };

  const errors = useMemo(() => validateProject(form), [form]);
  const err = (key: keyof ProjectForm) => (touched ? errors[key] : undefined);
  const manifest = useMemo(() => stringify(toProjectManifest(form)), [form]);

  const submit = async (dryRun: boolean) => {
    setTouched(true);
    if (Object.keys(errors).length) return;
    setSubmitting(dryRun ? 'validate' : 'create');
    setResult({});
    try {
      await api.createProject({
        name: form.name,
        owner: form.owner || undefined,
        description: form.description || undefined,
        spec: toProjectSpec(form),
        dryRun,
      });
      if (dryRun) {
        setResult({ validated: true });
      } else {
        navigate(projectLink?.({ name: form.name }) ?? '/cnpg/projects');
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
        title="Create project"
        description="A project with its own Prometheus and Grafana, ready for PostgreSQL clusters"
      />
      <Container>
        <Grid.Root columns={{ initial: '1', lg: '3' }} gap="4">
          <Grid.Item colSpan={{ initial: '1', lg: '2' }}>
            <Flex direction="column" gap="4">
              <Section title="Basics">
                <TextField
                  label="Name"
                  isRequired
                  value={form.name}
                  onChange={set('name')}
                  description={err('name') ?? 'Lowercase letters, digits and single "-", max 40 characters.'}
                  isInvalid={Boolean(err('name'))}
                />
                <TextField
                  label="Owner (group)"
                  value={form.owner}
                  onChange={set('owner')}
                  description={err('owner') ?? 'Catalog owner of the project and, by default, its databases.'}
                  isInvalid={Boolean(err('owner'))}
                />
                <TextField
                  label="Description"
                  value={form.description}
                  onChange={set('description')}
                  description={err('description')}
                  isInvalid={Boolean(err('description'))}
                />
              </Section>

              <Section
                title="Access"
                description="Kubernetes groups from your identity provider that get access to the project."
              >
                <TextField
                  label="Group with edit access"
                  value={form.editGroup}
                  onChange={set('editGroup')}
                  description='Built-in "edit" role: manage PostgresClusters, read Secrets.'
                />
                <TextField
                  label="Group with view access"
                  value={form.viewGroup}
                  onChange={set('viewGroup')}
                  description='Built-in "view" role.'
                />
              </Section>

              <Section title="Quota" description="Caps on what the whole project may request.">
                <Switch
                  label="Limit total resources"
                  isSelected={form.quotaEnabled}
                  onChange={set('quotaEnabled')}
                />
                {form.quotaEnabled && (
                  <>
                    <TextField
                      label="CPU requests"
                      value={form.quotaCpu}
                      onChange={set('quotaCpu')}
                      description={err('quotaCpu')}
                      isInvalid={Boolean(err('quotaCpu'))}
                    />
                    <TextField
                      label="Memory"
                      value={form.quotaMemory}
                      onChange={set('quotaMemory')}
                      description={err('quotaMemory')}
                      isInvalid={Boolean(err('quotaMemory'))}
                    />
                    <TextField
                      label="Storage"
                      value={form.quotaStorage}
                      onChange={set('quotaStorage')}
                      description={err('quotaStorage') ?? 'All PVCs together, including Prometheus.'}
                      isInvalid={Boolean(err('quotaStorage'))}
                    />
                  </>
                )}
              </Section>

              <Section
                title="Observability"
                description="Every PostgreSQL cluster in the project reports to this Prometheus and gets its dashboard in this Grafana."
              >
                <TextField
                  label="Metrics retention"
                  value={form.prometheusRetention}
                  onChange={set('prometheusRetention')}
                  description={err('prometheusRetention')}
                  isInvalid={Boolean(err('prometheusRetention'))}
                />
                <TextField
                  label="Prometheus volume size"
                  value={form.prometheusStorage}
                  onChange={set('prometheusStorage')}
                  description={err('prometheusStorage')}
                  isInvalid={Boolean(err('prometheusStorage'))}
                />
                <Switch
                  label="Expose Grafana through the cluster ingress"
                  isSelected={form.grafanaIngress}
                  onChange={set('grafanaIngress')}
                />
              </Section>
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
              createLabel="Create project"
            />
          </Grid.Item>
        </Grid.Root>
      </Container>
    </>
  );
};
