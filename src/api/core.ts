import { AzureDevOpsClient } from './client';
import { ConnectionData, Identity, ListResponse, TeamProject, WebApiTeam } from './types';

const enc = encodeURIComponent;

export interface PersonResult {
  id: string;
  displayName: string;
  mail?: string;
  isGroup: boolean;
}

export class CoreApi {
  constructor(private readonly client: AzureDevOpsClient) {}

  connectionData(): Promise<ConnectionData> {
    return this.client.json<ConnectionData>({ path: '_apis/connectionData', noApiVersion: true });
  }

  listProjects(): Promise<TeamProject[]> {
    return this.client.all<TeamProject>({
      path: '_apis/projects',
      query: { $top: 500, stateFilter: 'wellFormed' },
      scope: 'vso.project',
    });
  }

  getProject(nameOrId: string): Promise<TeamProject> {
    return this.client.json<TeamProject>({
      path: `_apis/projects/${enc(nameOrId)}`,
      query: { includeCapabilities: false },
      scope: 'vso.project',
    });
  }

  async listTeams(project: string): Promise<WebApiTeam[]> {
    const result = await this.client.json<ListResponse<WebApiTeam>>({
      path: `_apis/projects/${enc(project)}/teams`,
      query: { $top: 500 },
      preview: 1,
      scope: 'vso.project',
    });
    return result.value;
  }

  /** Searches users and groups by name or email. */
  async searchPeople(query: string): Promise<PersonResult[]> {
    const result = await this.client.json<ListResponse<Identity>>({
      service: 'identity',
      path: '_apis/identities',
      query: { searchFilter: 'General', filterValue: query, queryMembership: 'None' },
      scope: 'vso.identity',
    });
    return result.value
      .filter(identity => identity.isActive !== false)
      .map(identity => ({
        id: identity.id,
        displayName: identity.customDisplayName ?? identity.providerDisplayName,
        mail: identity.properties?.Mail?.$value || identity.properties?.Account?.$value,
        isGroup: identity.isContainer === true,
      }));
  }
}
