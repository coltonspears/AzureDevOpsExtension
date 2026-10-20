import { describe, expect, it } from 'vitest';
import { AzureDevOpsApi } from '../src/api/api';
import { AzureDevOpsClient } from '../src/api/client';
import { HttpRequest } from '../src/api/http';
import { GitPullRequest } from '../src/api/types';
import { parseOrganizationUrl } from '../src/api/urls';

function setup(responses: Record<string, unknown> = {}) {
  const requests: HttpRequest[] = [];
  const org = parseOrganizationUrl('contoso')!.organization;
  const hooks = { onScopeDenied() {}, onScopeGranted() {}, onAuthenticationFailed() {} };
  const client = new AzureDevOpsClient(
    org,
    'pat',
    async request => {
      requests.push(request);
      const key = Object.keys(responses).find(k => request.url.includes(k));
      const body = key ? responses[key] : { value: [] };
      return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(body)) };
    },
    hooks,
    '7.1',
  );
  const last = () => requests[requests.length - 1];
  return { api: new AzureDevOpsApi(client), requests, last };
}

const pr = {
  pullRequestId: 55,
  repository: { id: 'repo-id', name: 'web', project: { id: 'proj-id', name: 'My Project' } },
} as GitPullRequest;

describe('work items API', () => {
  it('runs WIQL in the project and batches work item reads', async () => {
    const { api, requests } = setup({ '/wiql': { queryType: 'flat', workItems: [{ id: 2 }, { id: 1 }] }, workitemsbatch: { value: [{ id: 1, fields: {} }, { id: 2, fields: {} }] } });
    const ids = await api.workItems.queryIds('My Project', 'SELECT 1', 50, 'Team A');
    const items = await api.workItems.getWorkItems(ids);
    expect(requests[0]).toMatchObject({ method: 'POST', url: 'https://dev.azure.com/contoso/My%20Project/Team%20A/_apis/wit/wiql?%24top=50&api-version=7.1' });
    expect(JSON.parse(String(requests[1].body))).toMatchObject({ ids: [2, 1] });
    expect(items.map(i => i.id)).toEqual([2, 1]);
  });

  it('creates work items with the type in the path and JSON Patch content', async () => {
    const { api, last } = setup({ workitems: { id: 9 } });
    await api.workItems.createWorkItem('Web', 'User Story', [{ op: 'add', path: '/fields/System.Title', value: 'x' }]);
    expect(last().url).toBe('https://dev.azure.com/contoso/Web/_apis/wit/workitems/%24User%20Story?api-version=7.1');
    expect(last().headers?.['Content-Type']).toBe('application/json-patch+json');
  });

  it('uses the preview comments API', async () => {
    const { api, last } = setup({ comments: { comments: [] } });
    await api.workItems.getComments('Web', 3);
    expect(last().url).toContain('/Web/_apis/wit/workItems/3/comments?');
    expect(last().url).toContain('api-version=7.1-preview.3');
  });

  it('flattens classification nodes into field paths', async () => {
    const { api } = setup({
      classificationnodes: {
        value: [
          { id: 1, name: 'Web', structureType: 'area', children: [{ id: 2, name: 'Api' }] },
          { id: 3, name: 'Web', structureType: 'iteration', children: [{ id: 4, name: 'Sprint 1' }] },
        ],
      },
    });
    expect(await api.workItems.getClassificationPaths('Web')).toEqual({ areas: ['Web', 'Web\\Api'], iterations: ['Web', 'Web\\Sprint 1'] });
  });
});

describe('git API', () => {
  it('searches pull requests with search criteria', async () => {
    const { api, last } = setup();
    await api.git.searchPullRequests('Web', { reviewerId: 'me', status: 'active' });
    const url = new URL(last().url);
    expect(url.pathname).toBe('/contoso/Web/_apis/git/pullrequests');
    expect(url.searchParams.get('searchCriteria.reviewerId')).toBe('me');
    expect(url.searchParams.get('searchCriteria.status')).toBe('active');
  });

  it('votes as the current user on the repository-scoped endpoint', async () => {
    const { api, last } = setup();
    await api.git.vote(pr, 'user-1', 10);
    expect(last()).toMatchObject({
      method: 'PUT',
      url: 'https://dev.azure.com/contoso/proj-id/_apis/git/repositories/repo-id/pullrequests/55/reviewers/user-1?api-version=7.1',
      body: '{"vote":10}',
    });
  });

  it('creates inline comment threads with file context', async () => {
    const { api, last } = setup();
    await api.git.createThread(pr, 'Nit', {
      threadContext: { filePath: '/a.ts', rightFileStart: { line: 3, offset: 1 }, rightFileEnd: { line: 3, offset: 1 } },
      changeTrackingId: 4,
      iterationId: 2,
    });
    expect(JSON.parse(String(last().body))).toEqual({
      comments: [{ parentCommentId: 0, content: 'Nit', commentType: 'text' }],
      status: 'active',
      threadContext: { filePath: '/a.ts', rightFileStart: { line: 3, offset: 1 }, rightFileEnd: { line: 3, offset: 1 } },
      pullRequestThreadContext: { changeTrackingId: 4, iterationContext: { firstComparingIteration: 1, secondComparingIteration: 2 } },
    });
  });

  it('follows change paging and drops folders', async () => {
    let call = 0;
    const requests: string[] = [];
    const org = parseOrganizationUrl('contoso')!.organization;
    const client = new AzureDevOpsClient(org, 'pat', async request => {
      requests.push(request.url);
      call++;
      const body =
        call === 1
          ? { changeEntries: [{ changeTrackingId: 1, changeType: 'edit', item: { path: '/a.ts' } }, { changeTrackingId: 2, changeType: 'add', item: { path: '/dir', isFolder: true } }], nextSkip: 2 }
          : { changeEntries: [{ changeTrackingId: 3, changeType: 'delete', item: { path: '/b.ts' } }] };
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(body)) };
    }, { onScopeDenied() {}, onScopeGranted() {}, onAuthenticationFailed() {} }, '7.1');
    const changes = await new AzureDevOpsApi(client).git.getChanges(pr, 3);
    expect(changes.map(c => c.item.path)).toEqual(['/a.ts', '/b.ts']);
    expect(requests[1]).toContain('%24skip=2');
  });

  it('builds web and artifact links', () => {
    const { api } = setup();
    expect(api.git.webUrl(pr)).toBe('https://dev.azure.com/contoso/My%20Project/_git/web/pullrequest/55');
    expect(api.git.artifactUri(pr)).toBe('vstfs:///Git/PullRequestId/proj-id%2Frepo-id%2F55');
  });
});

describe('builds API', () => {
  it('queues builds with variables as a JSON string and template parameters', async () => {
    const { api, last } = setup();
    await api.builds.queueBuild('Web', { definitionId: 7, sourceBranch: 'refs/heads/main', variables: { a: '1' }, templateParameters: { env: 'prod' } });
    expect(JSON.parse(String(last().body))).toEqual({
      definition: { id: 7 },
      sourceBranch: 'refs/heads/main',
      parameters: '{"a":"1"}',
      templateParameters: { env: 'prod' },
    });
  });

  it('cancels and retries through build updates', async () => {
    const { api, requests } = setup();
    await api.builds.cancelBuild('Web', 12);
    await api.builds.retryBuild('Web', 12);
    expect(requests[0]).toMatchObject({ method: 'PATCH', body: '{"status":"cancelling"}' });
    expect(requests[1].url).toContain('retry=true');
  });

  it('reads logs as text and approvals from the preview API', async () => {
    const { api, requests } = setup({ approvals: { value: [{ id: 'a', status: 'pending' }, { id: 'b', status: 'approved' }] } });
    await api.builds.getLog('Web', 12, 4);
    const approvals = await api.builds.listPendingApprovals('Web');
    expect(requests[0].headers?.Accept).toBe('text/plain');
    expect(requests[1].url).toContain('api-version=7.1-preview.1');
    expect(approvals.map(a => a.id)).toEqual(['a']);
  });

  it('talks to the release host for classic releases', async () => {
    const { api, last } = setup();
    await api.releases.listDefinitions('Web');
    expect(last().url).toMatch(/^https:\/\/vsrm\.dev\.azure\.com\/contoso\/Web\/_apis\/release\/definitions\?/);
  });
});
