import { Route, Routes } from 'react-router-dom';
import { ClusterDetailPage } from './ClusterDetailPage';
import { ClusterListPage } from './ClusterListPage';
import { CreateClusterPage } from './CreateClusterPage';
import { DashboardsPage } from './DashboardsPage';

/** Everything under /cnpg; paths mirror the sub-route refs in ../routes.ts. */
export const Router = () => (
  <Routes>
    <Route path="/" element={<ClusterListPage />} />
    <Route path="/create" element={<CreateClusterPage />} />
    <Route path="/dashboards" element={<DashboardsPage />} />
    <Route path="/:namespace/:name" element={<ClusterDetailPage tab="overview" />} />
    <Route path="/:namespace/:name/monitoring" element={<ClusterDetailPage tab="monitoring" />} />
  </Routes>
);
