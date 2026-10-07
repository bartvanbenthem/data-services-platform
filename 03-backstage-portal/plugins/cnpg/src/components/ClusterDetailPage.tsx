import { useApi, useRouteRef } from '@backstage/frontend-plugin-api';
import { usePermission } from '@backstage/plugin-permission-react';
import {
  Button,
  ButtonLink,
  Container,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  Flex,
  Header,
  Text,
  TextField,
} from '@backstage/ui';
import { cnpgClusterDeletePermission } from '@internal/backstage-plugin-cnpg-common';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import useAsync from 'react-use/esm/useAsync';
import useAsyncRetry from 'react-use/esm/useAsyncRetry';
import useInterval from 'react-use/esm/useInterval';
import { cnpgApiRef } from '../api';
import { rootRouteRef } from '../routes';
import { ClusterDetails, ClusterDetailsSkeleton } from './ClusterDetails';
import { ErrorAlert, grafanaLink, HealthBadge } from './common';

/** Loads (and keeps polling) one cluster; used by the page and the entity tab. */
export function useClusterDetails(namespace: string, name: string) {
  const api = useApi(cnpgApiRef);
  const state = useAsyncRetry(() => api.getCluster(namespace, name), [api, namespace, name]);
  useInterval(state.retry, 10_000);
  return state;
}

const DeleteDialog = ({
  namespace,
  name,
  isOpen,
  onOpenChange,
}: {
  namespace: string;
  name: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const api = useApi(cnpgApiRef);
  const navigate = useNavigate();
  const listLink = useRouteRef(rootRouteRef);
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<Error>();
  const [pending, setPending] = useState(false);

  const onDelete = async () => {
    setPending(true);
    try {
      await api.deleteCluster(namespace, name);
      onOpenChange(false);
      navigate(listLink?.() ?? '/cnpg');
    } catch (e) {
      setError(e as Error);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} width={520}>
      <DialogHeader>Delete {namespace}/{name}?</DialogHeader>
      <DialogBody>
        <Flex direction="column" gap="3">
          <Text>
            This deletes the PostgreSQL cluster, its pods and its volumes, together with the
            pooler, monitoring and backup schedule. Data in the backup object store is kept.
          </Text>
          <TextField
            label={`Type "${name}" to confirm`}
            value={confirm}
            onChange={setConfirm}
          />
          {error && <ErrorAlert error={error} />}
        </Flex>
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onPress={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          variant="primary"
          destructive
          isDisabled={confirm !== name}
          loading={pending}
          onPress={onDelete}
        >
          Delete
        </Button>
      </DialogFooter>
    </Dialog>
  );
};

export const ClusterDetailPage = () => {
  const { namespace = '', name = '' } = useParams();
  const api = useApi(cnpgApiRef);
  const listLink = useRouteRef(rootRouteRef);
  const { allowed: canDelete } = usePermission({ permission: cnpgClusterDeletePermission });
  const [deleting, setDeleting] = useState(false);
  const { value: config } = useAsync(() => api.getConfig(), [api]);
  const { value, error } = useClusterDetails(namespace, name);

  const dashboard = grafanaLink(config?.grafanaUrl, value?.resource.status?.monitoring?.dashboardUid);

  return (
    <>
      <Header
        title={name}
        breadcrumbs={listLink ? [{ label: 'PostgreSQL clusters', href: listLink() }] : undefined}
        tags={[{ label: `namespace: ${namespace}` }]}
        customActions={
          <Flex gap="2" align="center">
            {value && <HealthBadge cluster={value.summary} />}
            {dashboard && (
              <ButtonLink href={dashboard} target="_blank" variant="secondary">
                Grafana dashboard
              </ButtonLink>
            )}
            {canDelete && (
              <Button variant="secondary" destructive onPress={() => setDeleting(true)}>
                Delete
              </Button>
            )}
          </Flex>
        }
      />
      <Container>
        {error && !value && <ErrorAlert error={error} />}
        {!error && !value && <ClusterDetailsSkeleton />}
        {value && <ClusterDetails details={value} />}
      </Container>
      <DeleteDialog
        namespace={namespace}
        name={name}
        isOpen={deleting}
        onOpenChange={setDeleting}
      />
    </>
  );
};
