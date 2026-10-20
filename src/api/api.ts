import { BuildsApi, ReleasesApi } from './builds';
import { AzureDevOpsClient } from './client';
import { CoreApi } from './core';
import { GitApi } from './git';
import { WorkItemsApi } from './workItems';

/** All REST areas for one signed-in organization. */
export class AzureDevOpsApi {
  readonly core: CoreApi;
  readonly workItems: WorkItemsApi;
  readonly git: GitApi;
  readonly builds: BuildsApi;
  readonly releases: ReleasesApi;

  constructor(readonly client: AzureDevOpsClient) {
    this.core = new CoreApi(client);
    this.workItems = new WorkItemsApi(client);
    this.git = new GitApi(client);
    this.builds = new BuildsApi(client);
    this.releases = new ReleasesApi(client);
  }

  get organization() {
    return this.client.organization;
  }
}
