import {
  createApiRef,
  DiscoveryApi,
  FetchApi,
} from '@backstage/frontend-plugin-api';
import { ResponseError } from '@backstage/errors';
import type {
  PostgresCluster,
  PostgresClusterDetails,
  PostgresClusterSummary,
  Project,
  ProjectSummary,
} from '@internal/backstage-plugin-cnpg-common';

export interface CnpgPortalConfig {
  grafanaUrl?: string;
  defaultNamespace?: string;
  storageClasses: string[];
}

export interface CreateClusterRequest {
  name: string;
  namespace: string;
  owner?: string;
  spec: Record<string, unknown>;
  /** Validate against the XRD (server-side dry run) without creating anything. */
  dryRun?: boolean;
}

export interface CreateProjectRequest {
  /** Also the namespace name. */
  name: string;
  owner?: string;
  description?: string;
  /** Further Project spec (access, quota, observability). */
  spec?: Record<string, unknown>;
  /** Validate against the XRD (server-side dry run) without creating anything. */
  dryRun?: boolean;
}

/** Client for the cnpg backend plugin (/api/cnpg). */
export interface CnpgApi {
  getConfig(): Promise<CnpgPortalConfig>;
  listClusters(namespace?: string): Promise<PostgresClusterSummary[]>;
  getCluster(namespace: string, name: string): Promise<PostgresClusterDetails>;
  createCluster(request: CreateClusterRequest): Promise<PostgresCluster>;
  updateCluster(namespace: string, name: string, spec: Record<string, unknown>): Promise<PostgresCluster>;
  deleteCluster(namespace: string, name: string): Promise<void>;
  listProjects(): Promise<ProjectSummary[]>;
  getProject(name: string): Promise<{ summary: ProjectSummary; resource: Project }>;
  createProject(request: CreateProjectRequest): Promise<Project>;
}

export const cnpgApiRef = createApiRef<CnpgApi>().with({
  id: 'plugin.cnpg.client',
  pluginId: 'cnpg',
});

const enc = encodeURIComponent;

export class CnpgClient implements CnpgApi {
  constructor(
    private readonly options: { discoveryApi: DiscoveryApi; fetchApi: FetchApi },
  ) {}

  getConfig() {
    return this.#request<CnpgPortalConfig>('/config');
  }

  async listClusters(namespace?: string) {
    const query = namespace ? `?namespace=${encodeURIComponent(namespace)}` : '';
    return (await this.#request<{ items: PostgresClusterSummary[] }>(`/clusters${query}`)).items;
  }

  getCluster(namespace: string, name: string) {
    return this.#request<PostgresClusterDetails>(`/clusters/${enc(namespace)}/${enc(name)}`);
  }

  createCluster(request: CreateClusterRequest) {
    return this.#request<PostgresCluster>('/clusters', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  updateCluster(namespace: string, name: string, spec: Record<string, unknown>) {
    return this.#request<PostgresCluster>(`/clusters/${enc(namespace)}/${enc(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ spec }),
    });
  }

  async deleteCluster(namespace: string, name: string) {
    await this.#request(`/clusters/${enc(namespace)}/${enc(name)}`, { method: 'DELETE' });
  }

  async listProjects() {
    return (await this.#request<{ items: ProjectSummary[] }>('/projects')).items;
  }

  getProject(name: string) {
    return this.#request<{ summary: ProjectSummary; resource: Project }>(`/projects/${enc(name)}`);
  }

  createProject(request: CreateProjectRequest) {
    return this.#request<Project>('/projects', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  async #request<T>(path: string, init?: RequestInit): Promise<T> {
    const baseUrl = await this.options.discoveryApi.getBaseUrl('cnpg');
    const response = await this.options.fetchApi.fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
    if (!response.ok) {
      throw await ResponseError.fromResponse(response);
    }
    return (await response.json()) as T;
  }
}

