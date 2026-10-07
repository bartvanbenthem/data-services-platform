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
import {
  cnpgClusterDeletePermission,
  cnpgClusterUpdatePermission,
} from '@internal/backstage-plugin-cnpg-common';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import useAsync from 'react-use/esm/useAsync';
import useAsyncRetry from 'react-use/esm/useAsyncRetry';
import useInterval from 'react-use/esm/useInterval';
import { cnpgApiRef } from '../api';
import {
  clusterLogsRouteRef,
  clusterMonitoringRouteRef,
  clusterRouteRef,
  editClusterRouteRef,
  rootRouteRef,
} from '../routes';
import { ClusterDetails, ClusterDetailsSkeleton } from './ClusterDetails';
import { ClusterLogs } from './ClusterLogs';
import { ErrorAlert, HealthBadge } from './common';
import { GrafanaDashboard } from './GrafanaDashboard';

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

export const ClusterDetailPage = ({ tab }: { tab: 'overview' | 'monitoring' | 'logs' }) => {
  const { namespace = '', name = '' } = useParams();
  const api = useApi(cnpgApiRef);
  const overviewLink = useRouteRef(clusterRouteRef);
  const monitoringLink = useRouteRef(clusterMonitoringRouteRef);
  const logsLink = useRouteRef(clusterLogsRouteRef);
  const editLink = useRouteRef(editClusterRouteRef);
  const { allowed: canDelete } = usePermission({ permission: cnpgClusterDeletePermission });
  const { allowed: canUpdate } = usePermission({ permission: cnpgClusterUpdatePermission });
  const [deleting, setDeleting] = useState(false);
  const { value: config } = useAsync(() => api.getConfig(), [api]);
  const { value, error } = useClusterDetails(namespace, name);

  const params = { namespace, name };
  const tabs =
    overviewLink && monitoringLink && logsLink
      ? [
          { id: 'overview', label: 'Overview', href: overviewLink(params) },
          { id: 'monitoring', label: 'Monitoring', href: monitoringLink(params) },
          { id: 'logs', label: 'Logs', href: logsLink(params) },
        ]
      : undefined;

  return (
    <>
      <Header
        title={name}
        tags={[{ label: `project: ${namespace}` }]}
        tabs={tabs}
        activeTabId={tab}
        customActions={
          <Flex gap="3" align="center">
            {value && <HealthBadge cluster={value.summary} />}
            {canUpdate && editLink && value && !value.summary.deleting && (
              <ButtonLink href={editLink(params)} variant="secondary">
                Edit
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
        {value && tab === 'overview' && <ClusterDetails details={value} />}
        {value && tab === 'monitoring' && (
          <GrafanaDashboard
            grafanaUrl={value.summary.grafanaUrl ?? config?.grafanaUrl}
            namespace={namespace}
            name={name}
            uid={value.summary.dashboardUid}
          />
        )}
        {value && tab === 'logs' && (
          <ClusterLogs
            namespace={namespace}
            name={name}
            pods={value.pods}
            currentPrimary={value.summary.currentPrimary}
          />
        )}
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
