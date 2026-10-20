import { AzureDevOpsClient } from './client';
import {
  Build,
  BuildDefinition,
  BuildDefinitionReference,
  ListResponse,
  PipelineApproval,
  Release,
  ReleaseDefinition,
  Timeline,
} from './types';

const enc = encodeURIComponent;

export interface BuildQuery {
  definitionId?: number;
  requestedFor?: string;
  branch?: string;
  top?: number;
}

export interface QueueBuildRequest {
  definitionId: number;
  sourceBranch?: string;
  /** Pipeline variables to override at queue time. */
  variables?: Record<string, string>;
  /** YAML runtime parameters. */
  templateParameters?: Record<string, string>;
}

export class BuildsApi {
  constructor(private readonly client: AzureDevOpsClient) {}

  listDefinitions(project: string): Promise<BuildDefinitionReference[]> {
    return this.client.all<BuildDefinitionReference>(
      {
        path: `${enc(project)}/_apis/build/definitions`,
        query: { includeLatestBuilds: true, queryOrder: 'definitionNameAscending', $top: 500 },
        scope: 'vso.build',
      },
      2000,
    );
  }

  getDefinition(project: string, id: number): Promise<BuildDefinition> {
    return this.client.json<BuildDefinition>({
      path: `${enc(project)}/_apis/build/definitions/${id}`,
      scope: 'vso.build',
    });
  }

  async listBuilds(project: string, query: BuildQuery = {}): Promise<Build[]> {
    const result = await this.client.json<ListResponse<Build>>({
      path: `${enc(project)}/_apis/build/builds`,
      query: {
        definitions: query.definitionId,
        requestedFor: query.requestedFor,
        branchName: query.branch,
        queryOrder: 'queueTimeDescending',
        $top: query.top ?? 20,
      },
      scope: 'vso.build',
    });
    return result.value;
  }

  getBuild(project: string, buildId: number): Promise<Build> {
    return this.client.json<Build>({ path: `${enc(project)}/_apis/build/builds/${buildId}`, scope: 'vso.build' });
  }

  async getTimeline(project: string, buildId: number): Promise<Timeline | undefined> {
    return this.client.json<Timeline | undefined>({
      path: `${enc(project)}/_apis/build/builds/${buildId}/timeline`,
      scope: 'vso.build',
    });
  }

  getLog(project: string, buildId: number, logId: number): Promise<string> {
    return this.client.text({
      path: `${enc(project)}/_apis/build/builds/${buildId}/logs/${logId}`,
      scope: 'vso.build',
    });
  }

  queueBuild(project: string, request: QueueBuildRequest): Promise<Build> {
    return this.client.json<Build>({
      method: 'POST',
      path: `${enc(project)}/_apis/build/builds`,
      body: {
        definition: { id: request.definitionId },
        sourceBranch: request.sourceBranch,
        parameters: request.variables && Object.keys(request.variables).length ? JSON.stringify(request.variables) : undefined,
        templateParameters:
          request.templateParameters && Object.keys(request.templateParameters).length ? request.templateParameters : undefined,
      },
      scope: 'vso.build_execute',
    });
  }

  cancelBuild(project: string, buildId: number): Promise<Build> {
    return this.client.json<Build>({
      method: 'PATCH',
      path: `${enc(project)}/_apis/build/builds/${buildId}`,
      body: { status: 'cancelling' },
      scope: 'vso.build_execute',
    });
  }

  /** Re-runs the failed jobs of a completed run. */
  retryBuild(project: string, buildId: number): Promise<Build> {
    return this.client.json<Build>({
      method: 'PATCH',
      path: `${enc(project)}/_apis/build/builds/${buildId}`,
      query: { retry: true },
      body: {},
      scope: 'vso.build_execute',
    });
  }

  async listPendingApprovals(project: string): Promise<PipelineApproval[]> {
    const result = await this.client.json<ListResponse<PipelineApproval>>({
      path: `${enc(project)}/_apis/pipelines/approvals`,
      query: { state: 'pending', $expand: 'steps' },
      preview: 1,
      scope: 'vso.build',
    });
    return result.value.filter(a => a.status === 'pending');
  }

  async updateApproval(project: string, approvalId: string, status: 'approved' | 'rejected', comment: string): Promise<void> {
    await this.client.json<unknown>({
      method: 'PATCH',
      path: `${enc(project)}/_apis/pipelines/approvals`,
      body: [{ approvalId, status, comment }],
      preview: 1,
      scope: 'vso.build_execute',
    });
  }

  buildWebUrl(project: string, buildId: number): string {
    return `${this.client.organization.url}/${enc(project)}/_build/results?buildId=${buildId}`;
  }

  definitionWebUrl(project: string, definitionId: number): string {
    return `${this.client.organization.url}/${enc(project)}/_build?definitionId=${definitionId}`;
  }
}

export class ReleasesApi {
  constructor(private readonly client: AzureDevOpsClient) {}

  async listDefinitions(project: string): Promise<ReleaseDefinition[]> {
    const result = await this.client.json<ListResponse<ReleaseDefinition>>({
      service: 'release',
      path: `${enc(project)}/_apis/release/definitions`,
      query: { $top: 200, queryOrder: 'nameAscending' },
      scope: 'vso.release',
    });
    return result.value;
  }

  async listReleases(project: string, definitionId: number, top = 10): Promise<Release[]> {
    const result = await this.client.json<ListResponse<Release>>({
      service: 'release',
      path: `${enc(project)}/_apis/release/releases`,
      query: { definitionId, $top: top, $expand: 'environments', queryOrder: 'descending' },
      scope: 'vso.release',
    });
    return result.value;
  }

  releaseWebUrl(project: string, releaseId: number): string {
    return `${this.client.organization.url}/${enc(project)}/_releaseProgress?releaseId=${releaseId}&_a=release-pipeline-progress`;
  }

  definitionWebUrl(project: string, definitionId: number): string {
    return `${this.client.organization.url}/${enc(project)}/_release?definitionId=${definitionId}`;
  }
}
