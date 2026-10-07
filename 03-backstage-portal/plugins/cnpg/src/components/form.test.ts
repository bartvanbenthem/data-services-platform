import { defaultForm, toSpec, validate } from './form';

describe('create form', () => {
  it('maps the defaults onto a minimal spec', () => {
    const spec = toSpec({ ...defaultForm('demo'), name: 'orders-db' });
    expect(spec).toEqual({
      postgresVersion: 17,
      instances: 3,
      storage: { size: '10Gi' },
      resources: { requests: { cpu: '500m', memory: '1Gi' }, limits: { memory: '1Gi' } },
      database: { name: 'app', owner: 'app' },
      highAvailability: { podAntiAffinityType: 'preferred', zoneSpread: true, synchronousReplicas: 0 },
      monitoring: { enabled: true, grafanaDashboard: { enabled: true } },
    });
  });

  it('adds pooler, backup and WAL sections only when enabled', () => {
    const spec = toSpec({
      ...defaultForm('demo'),
      name: 'x',
      storageClass: 'premium',
      walEnabled: true,
      poolerEnabled: true,
      backupEnabled: true,
      backupDestinationPath: 's3://b/p',
      backupSecretName: 's3-creds',
      synchronousReplicas: 1,
    }) as any;
    expect(spec.walStorage).toEqual({ size: '5Gi', storageClass: 'premium' });
    expect(spec.pooler).toEqual({ enabled: true, instances: 2, poolMode: 'transaction', readOnly: false });
    expect(spec.backup).toMatchObject({ destinationPath: 's3://b/p', s3Credentials: { secretName: 's3-creds' } });
    expect(spec.backup.endpointURL).toBeUndefined();
    expect(spec.highAvailability.synchronousDataDurability).toBe('preferred');
  });

  it('flags invalid input', () => {
    const errors = validate({
      ...defaultForm(''),
      name: 'Orders_DB',
      instances: 2,
      synchronousReplicas: 2,
      backupEnabled: true,
      backupSchedule: '0 2 * * *',
    });
    expect(Object.keys(errors).sort()).toEqual(
      ['backupDestinationPath', 'backupSchedule', 'backupSecretName', 'name', 'namespace', 'synchronousReplicas'].sort(),
    );
  });

  it('accepts a valid form', () => {
    expect(validate({ ...defaultForm('demo'), name: 'orders-db' })).toEqual({});
  });
});
