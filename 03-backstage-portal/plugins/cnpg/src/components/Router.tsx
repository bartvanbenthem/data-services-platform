import { Route, Routes } from 'react-router-dom';
import { ClusterDetailPage } from './ClusterDetailPage';
import { ClusterListPage } from './ClusterListPage';
import { CreateClusterPage } from './CreateClusterPage';
import { CreateProjectPage } from './CreateProjectPage';
import { DashboardsPage } from './DashboardsPage';
import { ProjectDetailPage } from './ProjectDetailPage';
import { ProjectListPage } from './ProjectListPage';

/** Everything under /cnpg; paths mirror the sub-route refs in ../routes.ts. */
export const Router = () => (
  <Routes>
    <Route path="/" element={<ClusterListPage />} />
    <Route path="/create" element={<CreateClusterPage />} />
    <Route path="/dashboards" element={<DashboardsPage />} />
    {/* Static "projects" segments outrank /:namespace/:name; "projects" is a reserved project name. */}
    <Route path="/projects" element={<ProjectListPage />} />
    <Route path="/projects/create" element={<CreateProjectPage />} />
    <Route path="/projects/:name" element={<ProjectDetailPage />} />
    <Route path="/:namespace/:name" element={<ClusterDetailPage tab="overview" />} />
    <Route path="/:namespace/:name/monitoring" element={<ClusterDetailPage tab="monitoring" />} />
  </Routes>
);
