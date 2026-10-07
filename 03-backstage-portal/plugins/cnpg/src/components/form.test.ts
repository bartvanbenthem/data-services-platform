import type { PostgresCluster } from '@internal/backstage-plugin-cnpg-common';
import {
  defaultForm,
  fromCluster,
  mergePatch,
  toEditPatch,
  toSpec,
  validate,
  validateEdit,
} from './form';

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

/** As the API server returns it: XRD defaults filled in, plus a field the form doesn't know. */
const live: PostgresCluster = {
  apiVersion: 'cnpg.cncp.nl/v1alpha1',
  kind: 'PostgresCluster',
  metadata: { name: 'orders-db', namespace: 'demo', labels: { 'backstage.io/owner': 'team-orders' } },
  spec: {
    postgresVersion: 17,
    instances: 3,
    storage: { size: '20Gi', storageClass: 'premium' },
    walStorage: { size: '5Gi', storageClass: 'premium' },
    resources: { requests: { cpu: '1', memory: '2Gi' }, limits: { memory: '2Gi' } },
    database: { name: 'orders', owner: 'orders' },
    highAvailability: { podAntiAffinityType: 'preferred', zoneSpread: true, synchronousReplicas: 1, synchronousDataDurability: 'required' },
    pooler: { enabled: true, instances: 2, poolMode: 'transaction', readOnly: false, maxClientConn: 500 },
    backup: { enabled: false, retentionPolicy: '30d', schedule: '0 0 2 * * *' },
    monitoring: { enabled: true, grafanaDashboard: { enabled: true } },
  },
};

describe('edit form', () => {
  const original = fromCluster(live);

  it('reads an existing cluster into the form', () => {
    expect(original).toMatchObject({
      name: 'orders-db',
      namespace: 'demo',
      owner: 'team-orders',
      storageSize: '20Gi',
      storageClass: 'premium',
      walEnabled: true,
      cpu: '1',
      memory: '2Gi',
      databaseName: 'orders',
      synchronousReplicas: 1,
      synchronousDataDurability: 'required',
      poolerEnabled: true,
      backupEnabled: false,
    });
  });

  it('sends nothing when nothing changed', () => {
    expect(toEditPatch(original, original)).toEqual({});
  });

  it('sends only the changed fields', () => {
    expect(
      toEditPatch(original, { ...original, instances: 5, storageSize: '50Gi', walSize: '10Gi' }),
    ).toEqual({ instances: 5, storage: { size: '50Gi' }, walStorage: { size: '10Gi' } });
  });

  it('turns the pooler off without dropping its settings', () => {
    expect(toEditPatch(original, { ...original, poolerEnabled: false })).toEqual({
      pooler: { enabled: false },
    });
  });

  it('enables backups', () => {
    const patch = toEditPatch(original, {
      ...original,
      backupEnabled: true,
      backupDestinationPath: 's3://bucket/pg',
      backupSecretName: 's3-creds',
    });
    expect(patch).toEqual({
      backup: {
        enabled: true,
        destinationPath: 's3://bucket/pg',
        s3Credentials: { secretName: 's3-creds' },
      },
    });
    // Off again: only the switch flips, the destination stays for next time.
    const enabled = { ...original, backupEnabled: true, backupDestinationPath: 's3://b/p', backupSecretName: 's' };
    expect(toEditPatch(enabled, { ...enabled, backupEnabled: false })).toEqual({ backup: { enabled: false } });
  });

  it('refuses to shrink volumes', () => {
    const errors = validateEdit(original, { ...original, storageSize: '10Gi', walSize: '1Gi' });
    expect(errors.storageSize).toMatch(/not shrink/);
    expect(errors.walSize).toMatch(/not shrink/);
    expect(validateEdit(original, { ...original, storageSize: '1Ti' })).toEqual({});
  });
});

describe('mergePatch', () => {
  it('nulls removed keys and replaces arrays whole', () => {
    expect(mergePatch({ a: 1, b: { c: 2 }, l: [1] }, { a: 1, l: [1, 2] })).toEqual({ b: null, l: [1, 2] });
    expect(mergePatch({ a: [1] }, { a: [1] })).toBeUndefined();
  });
});
