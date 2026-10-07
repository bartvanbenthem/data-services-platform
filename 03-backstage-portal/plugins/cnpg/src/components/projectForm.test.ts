import { defaultProjectForm, toProjectManifest, toProjectSpec, validateProject } from './projectForm';

describe('create-project form', () => {
  it('maps the defaults onto observability settings only', () => {
    expect(toProjectSpec({ ...defaultProjectForm(), name: 'team-a' })).toEqual({
      observability: {
        prometheus: { retention: '7d', storage: { size: '10Gi' } },
        grafana: { ingress: true },
      },
    });
  });

  it('adds access entries and the quota only when set', () => {
    const spec = toProjectSpec({
      ...defaultProjectForm(),
      name: 'team-a',
      editGroup: ' team-a-devs ',
      viewGroup: 'auditors',
      quotaEnabled: true,
    }) as any;
    expect(spec.access).toEqual([
      { group: 'team-a-devs', role: 'edit' },
      { group: 'auditors', role: 'view' },
    ]);
    expect(spec.quota).toEqual({ cpu: '8', memory: '32Gi', storage: '200Gi' });
  });

  it('puts owner and description into the manifest preview', () => {
    const manifest = toProjectManifest({
      ...defaultProjectForm(),
      name: 'team-a',
      owner: 'team-a',
      description: 'Team A',
    });
    expect(manifest.metadata).toEqual({ name: 'team-a' });
    expect(manifest.spec).toMatchObject({ owner: 'team-a', description: 'Team A' });
  });

  it('mirrors the XRD name rules', () => {
    const nameError = (name: string) => validateProject({ ...defaultProjectForm(), name }).name;
    expect(nameError('team-a')).toBeUndefined();
    expect(nameError('Team_A')).toBeDefined();
    expect(nameError('a--b')).toBeDefined();
    expect(nameError('kube-x')).toMatch(/reserved/);
    expect(nameError('projects')).toMatch(/reserved/);
    expect(nameError('x'.repeat(41))).toBeDefined();
  });

  it('flags invalid quota and retention values', () => {
    const errors = validateProject({
      ...defaultProjectForm(),
      name: 'team-a',
      quotaEnabled: true,
      quotaMemory: '32GB',
      prometheusRetention: '7 days',
    });
    expect(Object.keys(errors).sort()).toEqual(['prometheusRetention', 'quotaMemory']);
  });
});
