import { AzureDevOpsClient } from './client';
import { TtlCache } from '../util/cache';
import {
  CommentThreadContext,
  GitCommitRef,
  GitPullRequest,
  GitPullRequestCompletionOptions,
  GitRef,
  GitRepository,
  GitStatus,
  IdentityRefWithVote,
  ListResponse,
  PolicyEvaluationRecord,
  PullRequestChange,
  PullRequestChanges,
  PullRequestComment,
  PullRequestIteration,
  PullRequestStatus,
  PullRequestThread,
  ResourceRef,
  ThreadStatus,
} from './types';

const enc = encodeURIComponent;

export interface PullRequestSearch {
  status?: PullRequestStatus;
  creatorId?: string;
  reviewerId?: string;
  repositoryId?: string;
  sourceRefName?: string;
  targetRefName?: string;
  top?: number;
}

export interface NewPullRequest {
  sourceRefName: string;
  targetRefName: string;
  title: string;
  description?: string;
  isDraft?: boolean;
  reviewers?: { id: string }[];
  workItemRefs?: { id: string }[];
}

export type PullRequestUpdate = Partial<{
  title: string;
  description: string;
  status: PullRequestStatus;
  isDraft: boolean;
  lastMergeSourceCommit: { commitId: string };
  completionOptions: GitPullRequestCompletionOptions;
  autoCompleteSetBy: { id: string };
}>;

export const VOTES = {
  approve: 10,
  approveWithSuggestions: 5,
  reset: 0,
  waitForAuthor: -5,
  reject: -10,
} as const;

export function voteLabel(vote: number): string {
  switch (vote) {
    case 10:
      return 'Approved';
    case 5:
      return 'Approved with suggestions';
    case -5:
      return 'Waiting for author';
    case -10:
      return 'Rejected';
    default:
      return 'No vote';
  }
}

export function shortRefName(ref: string | undefined): string {
  return (ref ?? '').replace(/^refs\/heads\//, '');
}

export class GitApi {
  private readonly cache = new TtlCache(5 * 60_000);

  constructor(private readonly client: AzureDevOpsClient) {}

  listRepositories(project: string): Promise<GitRepository[]> {
    return this.cache.get(`repos:${project}`, async () => {
      const result = await this.client.json<ListResponse<GitRepository>>({
        path: `${enc(project)}/_apis/git/repositories`,
        scope: 'vso.code',
      });
      return result.value.filter(r => !r.isDisabled).sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  getRepository(project: string, nameOrId: string): Promise<GitRepository> {
    return this.cache.get(`repo:${project}:${nameOrId.toLowerCase()}`, () =>
      this.client.json<GitRepository>({
        path: `${enc(project)}/_apis/git/repositories/${enc(nameOrId)}`,
        scope: 'vso.code',
      }),
    );
  }

  async listBranches(project: string, repositoryId: string): Promise<string[]> {
    const refs = await this.client.all<GitRef>({
      path: `${enc(project)}/_apis/git/repositories/${enc(repositoryId)}/refs`,
      query: { filter: 'heads/', $top: 1000 },
      scope: 'vso.code',
    });
    return refs.map(r => shortRefName(r.name));
  }

  async searchPullRequests(project: string, search: PullRequestSearch): Promise<GitPullRequest[]> {
    const path = search.repositoryId
      ? `${enc(project)}/_apis/git/repositories/${enc(search.repositoryId)}/pullrequests`
      : `${enc(project)}/_apis/git/pullrequests`;
    const result = await this.client.json<ListResponse<GitPullRequest>>({
      path,
      query: {
        'searchCriteria.status': search.status ?? 'active',
        'searchCriteria.creatorId': search.creatorId,
        'searchCriteria.reviewerId': search.reviewerId,
        'searchCriteria.sourceRefName': search.sourceRefName,
        'searchCriteria.targetRefName': search.targetRefName,
        $top: search.top ?? 100,
      },
      scope: 'vso.code',
    });
    return result.value;
  }

  getPullRequest(pullRequestId: number): Promise<GitPullRequest> {
    return this.client.json<GitPullRequest>({
      path: `_apis/git/pullrequests/${pullRequestId}`,
      scope: 'vso.code',
    });
  }

  createPullRequest(project: string, repositoryId: string, request: NewPullRequest): Promise<GitPullRequest> {
    return this.client.json<GitPullRequest>({
      method: 'POST',
      path: `${this.repoPath(project, repositoryId)}/pullrequests`,
      query: { supportsIterations: true },
      body: request,
      scope: 'vso.code_write',
    });
  }

  updatePullRequest(pr: GitPullRequest, update: PullRequestUpdate): Promise<GitPullRequest> {
    return this.client.json<GitPullRequest>({
      method: 'PATCH',
      path: `${this.prPath(pr)}`,
      body: update,
      scope: 'vso.code_write',
    });
  }

  vote(pr: GitPullRequest, reviewerId: string, vote: number): Promise<IdentityRefWithVote> {
    return this.client.json<IdentityRefWithVote>({
      method: 'PUT',
      path: `${this.prPath(pr)}/reviewers/${enc(reviewerId)}`,
      body: { vote },
      scope: 'vso.code_write',
    });
  }

  addReviewer(pr: GitPullRequest, reviewerId: string, isRequired: boolean): Promise<IdentityRefWithVote> {
    return this.client.json<IdentityRefWithVote>({
      method: 'PUT',
      path: `${this.prPath(pr)}/reviewers/${enc(reviewerId)}`,
      body: { vote: 0, isRequired },
      scope: 'vso.code_write',
    });
  }

  async removeReviewer(pr: GitPullRequest, reviewerId: string): Promise<void> {
    await this.client.json<void>({
      method: 'DELETE',
      path: `${this.prPath(pr)}/reviewers/${enc(reviewerId)}`,
      scope: 'vso.code_write',
    });
  }

  async getThreads(pr: GitPullRequest): Promise<PullRequestThread[]> {
    const result = await this.client.json<ListResponse<PullRequestThread>>({
      path: `${this.prPath(pr)}/threads`,
      scope: 'vso.code',
    });
    return result.value.filter(t => !t.isDeleted);
  }

  createThread(
    pr: GitPullRequest,
    content: string,
    context?: { threadContext: CommentThreadContext; changeTrackingId?: number; iterationId?: number },
  ): Promise<PullRequestThread> {
    return this.client.json<PullRequestThread>({
      method: 'POST',
      path: `${this.prPath(pr)}/threads`,
      body: {
        comments: [{ parentCommentId: 0, content, commentType: 'text' }],
        status: 'active',
        threadContext: context?.threadContext,
        pullRequestThreadContext:
          context?.iterationId !== undefined
            ? {
                changeTrackingId: context.changeTrackingId,
                iterationContext: { firstComparingIteration: 1, secondComparingIteration: context.iterationId },
              }
            : undefined,
      },
      scope: 'vso.code_write',
    });
  }

  reply(pr: GitPullRequest, threadId: number, content: string, parentCommentId = 1): Promise<PullRequestComment> {
    return this.client.json<PullRequestComment>({
      method: 'POST',
      path: `${this.prPath(pr)}/threads/${threadId}/comments`,
      body: { content, parentCommentId, commentType: 'text' },
      scope: 'vso.code_write',
    });
  }

  setThreadStatus(pr: GitPullRequest, threadId: number, status: ThreadStatus): Promise<PullRequestThread> {
    return this.client.json<PullRequestThread>({
      method: 'PATCH',
      path: `${this.prPath(pr)}/threads/${threadId}`,
      body: { status },
      scope: 'vso.code_write',
    });
  }

  editComment(pr: GitPullRequest, threadId: number, commentId: number, content: string): Promise<PullRequestComment> {
    return this.client.json<PullRequestComment>({
      method: 'PATCH',
      path: `${this.prPath(pr)}/threads/${threadId}/comments/${commentId}`,
      body: { content },
      scope: 'vso.code_write',
    });
  }

  async deleteComment(pr: GitPullRequest, threadId: number, commentId: number): Promise<void> {
    await this.client.json<void>({
      method: 'DELETE',
      path: `${this.prPath(pr)}/threads/${threadId}/comments/${commentId}`,
      scope: 'vso.code_write',
    });
  }

  async getIterations(pr: GitPullRequest): Promise<PullRequestIteration[]> {
    const result = await this.client.json<ListResponse<PullRequestIteration>>({
      path: `${this.prPath(pr)}/iterations`,
      scope: 'vso.code',
    });
    return result.value;
  }

  /** All file changes of an iteration compared to the target branch. */
  async getChanges(pr: GitPullRequest, iterationId: number): Promise<PullRequestChange[]> {
    const changes: PullRequestChange[] = [];
    let skip = 0;
    for (let page = 0; page < 20; page++) {
      const result = await this.client.json<PullRequestChanges>({
        path: `${this.prPath(pr)}/iterations/${iterationId}/changes`,
        query: { $top: 1000, $skip: skip, $compareTo: 0 },
        scope: 'vso.code',
      });
      changes.push(...result.changeEntries);
      if (!result.nextSkip) {
        break;
      }
      skip = result.nextSkip;
    }
    return changes.filter(c => !c.item.isFolder && c.item.gitObjectType !== 'tree');
  }

  getBlob(project: string, repositoryId: string, objectId: string): Promise<Buffer> {
    return this.client.buffer({
      path: `${this.repoPath(project, repositoryId)}/blobs/${enc(objectId)}`,
      query: { $format: 'octetstream' },
      scope: 'vso.code',
    });
  }

  async getWorkItemRefs(pr: GitPullRequest): Promise<ResourceRef[]> {
    const result = await this.client.json<ListResponse<ResourceRef>>({
      path: `${this.prPath(pr)}/workitems`,
      scope: 'vso.code',
    });
    return result.value;
  }

  async getCommits(pr: GitPullRequest): Promise<GitCommitRef[]> {
    const result = await this.client.json<ListResponse<GitCommitRef>>({
      path: `${this.prPath(pr)}/commits`,
      query: { $top: 100 },
      scope: 'vso.code',
    });
    return result.value;
  }

  async getStatuses(pr: GitPullRequest): Promise<GitStatus[]> {
    const result = await this.client.json<ListResponse<GitStatus>>({
      path: `${this.prPath(pr)}/statuses`,
      preview: 1,
      scope: 'vso.code',
    });
    return result.value;
  }

  async getPolicyEvaluations(pr: GitPullRequest): Promise<PolicyEvaluationRecord[]> {
    const projectId = pr.repository.project.id;
    const result = await this.client.json<ListResponse<PolicyEvaluationRecord>>({
      path: `${enc(projectId)}/_apis/policy/evaluations`,
      query: { artifactId: `vstfs:///CodeReview/CodeReviewId/${projectId}/${pr.pullRequestId}` },
      preview: 1,
      scope: 'vso.code',
    });
    return result.value;
  }

  /** Commits on `source` that are not on `target`, newest first. */
  async getCommitsBetween(project: string, repositoryId: string, source: string, target: string): Promise<GitCommitRef[]> {
    const result = await this.client.json<ListResponse<GitCommitRef>>({
      method: 'POST',
      path: `${this.repoPath(project, repositoryId)}/commitsbatch`,
      query: { $top: 50 },
      body: {
        itemVersion: { version: source, versionType: 'branch' },
        compareVersion: { version: target, versionType: 'branch' },
      },
      scope: 'vso.code',
    });
    return result.value;
  }

  webUrl(pr: GitPullRequest): string {
    return `${this.client.organization.url}/${enc(pr.repository.project.name)}/_git/${enc(pr.repository.name)}/pullrequest/${pr.pullRequestId}`;
  }

  repositoryWebUrl(project: string, repositoryName: string): string {
    return `${this.client.organization.url}/${enc(project)}/_git/${enc(repositoryName)}`;
  }

  /** Artifact URI used to link a pull request from a work item. */
  artifactUri(pr: GitPullRequest): string {
    return `vstfs:///Git/PullRequestId/${pr.repository.project.id}%2F${pr.repository.id}%2F${pr.pullRequestId}`;
  }

  private repoPath(project: string, repositoryId: string): string {
    return `${enc(project)}/_apis/git/repositories/${enc(repositoryId)}`;
  }

  private prPath(pr: GitPullRequest): string {
    return `${this.repoPath(pr.repository.project.id, pr.repository.id)}/pullrequests/${pr.pullRequestId}`;
  }
}
