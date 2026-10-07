import { Route, Routes } from 'react-router-dom';
import { ClusterDetailPage } from './ClusterDetailPage';
import { ClusterListPage } from './ClusterListPage';
import { CreateClusterPage } from './CreateClusterPage';

/** Everything under /cnpg; paths mirror the sub-route refs in ../routes.ts. */
export const Router = () => (
  <Routes>
    <Route path="/" element={<ClusterListPage />} />
    <Route path="/create" element={<CreateClusterPage />} />
    <Route path="/:namespace/:name" element={<ClusterDetailPage />} />
  </Routes>
);
