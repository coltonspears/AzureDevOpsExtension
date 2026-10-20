import * as vscode from 'vscode';
import { shortRefName } from '../api/git';
import { GitPullRequest, PullRequestChange, PullRequestThread, ThreadStatus } from '../api/types';
import { organizationKey } from '../api/urls';
import { ZERO_GUID } from '../auth/scopeProbe';
import { pickReviewer } from '../commands/people';
import { Services } from '../services';
import { PullRequestToHost, PullRequestToWebview, PullRequestViewState, ThreadModel } from '../shared/messages';
import { changeTypeLabel } from '../views/pullRequestsTree';
import { summarizeWorkItem } from '../views/workItemsTree';
import { policyChecks, statusChecks } from './checks';
import { WebviewPanelBase } from './panelBase';
import { WorkItemPanel } from './workItemPanel';

type MergeStrategy = 'squash' | 'noFastForward' | 'rebase' | 'rebaseMerge';

/** Overview, review and actions for one pull request. */
export class PullRequestPanel extends WebviewPanelBase<PullRequestToHost, PullRequestToWebview> {
  private static readonly panels = new Map<string, PullRequestPanel>();
  private static readonly changedEmitter = new vscode.EventEmitter<number>();
  /** Fires with a pull request id after it was changed from a panel. */
  static readonly onDidChangePullRequest = PullRequestPanel.changedEmitter.event;

  private pr?: GitPullRequest;
  private changes: PullRequestChange[] = [];
  private iterationId?: number;
  private state: PullRequestViewState = {
    loading: true,
    canContribute: 'unknown',
    reviewers: [],
    threads: [],
    files: [],
    commits: [],
    checks: [],
    workItems: [],
    identities: {},
  };

  static show(services: Services, id: number, onLoaded?: (pr: GitPullRequest, threads: PullRequestThread[]) => void): void {
    const connection = services.connections.require();
    const key = `${organizationKey(connection.organization)}:${id}`;
    const existing = PullRequestPanel.panels.get(key);
    if (existing && !existing.disposed) {
      existing.reveal();
      void existing.load();
      return;
    }
    const panel = new PullRequestPanel(services, id, onLoaded);
    PullRequestPanel.panels.set(key, panel);
    panel.onDidDispose(() => PullRequestPanel.panels.delete(key));
  }

  static refreshIfOpen(id: number): void {
    for (const panel of PullRequestPanel.panels.values()) {
      if (panel.id === id && !panel.disposed) {
        void panel.load();
      }
    }
  }

  private constructor(
    services: Services,
    readonly id: number,
    private readonly onLoaded?: (pr: GitPullRequest, threads: PullRequestThread[]) => void,
  ) {
    super(services, 'azureDevOps.pullRequest', `Pull Request !${id}`, 'pullRequest');
    this.track(
      services.access.onDidChange(() => {
        const canContribute = services.access.get('vso.code_write');
        if (canContribute !== this.state.canContribute) {
          this.state = { ...this.state, canContribute };
          this.push();
        }
      }),
    );
  }

  protected async onReady(): Promise<void> {
    await this.load();
  }

  async load(): Promise<void> {
    const { api, user } = this.services.connections.require();
    this.state = { ...this.state, loading: !this.pr, error: undefined };
    this.push();
    try {
      const pr = await api.git.getPullRequest(this.id);
      const iterationsLoad = api.git.getIterations(pr);
      const [threads, iterations, workItemRefs, commits, evaluations, statuses] = await Promise.all([
        iterationsLoad.then(list => api.git.getThreads(pr, list[list.length - 1]?.id)),
        iterationsLoad,
        api.git.getWorkItemRefs(pr).catch(() => []),
        api.git.getCommits(pr).catch(() => []),
        api.git.getPolicyEvaluations(pr).catch(() => []),
        api.git.getStatuses(pr).catch(() => []),
      ]);
      const latest = iterations[iterations.length - 1];
      const changes = latest ? await api.git.getChanges(pr, latest.id) : [];
      const workItemIds = workItemRefs.map(r => Number(r.id)).filter(n => !Number.isNaN(n));
      const workItems = workItemIds.length ? await api.workItems.getWorkItems(workItemIds).catch(() => []) : [];

      this.pr = pr;
      this.changes = changes;
      this.iterationId = latest?.id;
      this.onLoaded?.(pr, threads);

      const identities: Record<string, string> = {};
      const remember = (id: string | undefined, name: string | undefined) => {
        if (id && name) {
          identities[id.toLowerCase()] = name;
        }
      };
      remember(pr.createdBy.id, pr.createdBy.displayName);
      pr.reviewers.forEach(r => remember(r.id, r.displayName));
      threads.forEach(t => t.comments.forEach(c => remember(c.author.id, c.author.displayName)));

      const fileComments = new Map<string, number>();
      for (const thread of threads) {
        const path = thread.threadContext?.filePath;
        if (path) {
          fileComments.set(path, (fileComments.get(path) ?? 0) + thread.comments.filter(c => c.commentType !== 'system').length);
        }
      }

      const config = vscode.workspace.getConfiguration('azureDevOps.pullRequests');
      const myReviewer = pr.reviewers.find(r => r.id === user.id);
      const project = pr.repository.project.name;
      this.setTitle(`!${pr.pullRequestId}: ${pr.title.length > 40 ? `${pr.title.slice(0, 40)}…` : pr.title}`);
      this.state = {
        loading: false,
        canContribute: this.services.access.get('vso.code_write'),
        pr: {
          id: pr.pullRequestId,
          title: pr.title,
          description: pr.description ?? '',
          status: pr.status,
          isDraft: pr.isDraft === true,
          mergeStatus: pr.mergeStatus,
          author: pr.createdBy.displayName,
          isAuthor: pr.createdBy.id === user.id,
          created: pr.creationDate,
          closed: pr.closedDate,
          source: shortRefName(pr.sourceRefName),
          target: shortRefName(pr.targetRefName),
          repository: pr.repository.name,
          webUrl: api.git.webUrl(pr),
          myVote: myReviewer?.vote,
          amReviewer: !!myReviewer,
          autoCompleteBy: pr.autoCompleteSetBy?.displayName,
          labels: (pr.labels ?? []).filter(l => l.active !== false).map(l => l.name),
          defaultMergeStrategy: pr.completionOptions?.mergeStrategy ?? config.get<string>('defaultMergeStrategy', 'squash'),
          defaultDeleteSourceBranch: pr.completionOptions?.deleteSourceBranch ?? config.get<boolean>('deleteSourceBranch', true),
          defaultTransitionWorkItems: pr.completionOptions?.transitionWorkItems ?? config.get<boolean>('transitionWorkItems', true),
          defaultMergeMessage: pr.completionOptions?.mergeCommitMessage ?? `Merged PR ${pr.pullRequestId}: ${pr.title}`,
        },
        reviewers: pr.reviewers
          .map(r => ({
            id: r.id,
            name: r.displayName,
            vote: r.vote,
            isRequired: r.isRequired === true,
            isGroup: r.isContainer === true,
            isMe: r.id === user.id,
          }))
          .sort((a, b) => Number(b.isRequired) - Number(a.isRequired) || a.name.localeCompare(b.name)),
        threads: threads.map(t => this.threadModel(t, user.id)).sort((a, b) => a.date.localeCompare(b.date)),
        files: changes
          .map(c => ({
            path: c.item.path,
            changeType: changeTypeLabel(c.changeType).label,
            changeLetter: changeTypeLabel(c.changeType).letter,
            originalPath: c.originalPath ?? c.sourceServerItem,
            comments: fileComments.get(c.item.path) ?? 0,
          }))
          .sort((a, b) => a.path.localeCompare(b.path)),
        commits: commits.map(c => ({
          id: c.commitId,
          message: c.comment ?? '',
          author: c.author?.name ?? '',
          date: c.author?.date ?? '',
        })),
        checks: [
          ...policyChecks(evaluations, id => api.builds.buildWebUrl(project, id)),
          ...statusChecks(statuses),
        ],
        workItems: workItems.map(w => {
          const s = summarizeWorkItem(w);
          return { id: s.id, title: s.title, type: s.type, state: s.state };
        }),
        identities,
      };
    } catch (error) {
      this.state = { ...this.state, loading: false, error: error instanceof Error ? error.message : String(error) };
    }
    this.push();
  }

  private threadModel(thread: PullRequestThread, userId: string): ThreadModel {
    const comments = thread.comments.filter(c => !c.isDeleted);
    return {
      id: thread.id,
      status: thread.status ?? 'unknown',
      filePath: thread.threadContext?.filePath,
      line: thread.threadContext?.rightFileStart?.line ?? thread.threadContext?.leftFileStart?.line,
      isSystem: comments.length > 0 && comments.every(c => c.commentType === 'system'),
      date: thread.publishedDate ?? comments[0]?.publishedDate ?? '',
      comments: comments.map(c => ({
        id: c.id,
        author: c.author.displayName,
        date: c.publishedDate ?? '',
        markdown: c.content ?? '',
        isMine: c.author.id === userId,
      })),
    };
  }

  protected async onMessage(message: PullRequestToHost): Promise<void> {
    const pr = this.pr;
    if (message.type === 'refresh') {
      await this.load();
      return;
    }
    if (!pr) {
      return;
    }
    const { api, user } = this.services.connections.require();
    const write = (action: string) => this.services.access.ensure('vso.code_write', action);
    const mutate = async (label: string, action: () => Promise<unknown>) => {
      await this.run(label, async () => {
        await action();
        PullRequestPanel.changedEmitter.fire(pr.pullRequestId);
        await this.load();
      });
    };

    switch (message.type) {
      case 'vote':
        if (await write('vote on pull requests')) {
          await mutate('Vote', () => api.git.vote(pr, user.id, message.vote));
        }
        return;
      case 'complete': {
        if (!(await write('complete pull requests'))) {
          return;
        }
        if (pr.mergeStatus === 'conflicts') {
          void vscode.window.showWarningMessage('This pull request has merge conflicts. Resolve them before completing.');
          return;
        }
        const confirm = await vscode.window.showWarningMessage(
          `Complete pull request !${pr.pullRequestId} into ${shortRefName(pr.targetRefName)}?`,
          { modal: true, detail: `Merge type: ${message.mergeStrategy}${message.deleteSourceBranch ? ' · delete source branch' : ''}` },
          'Complete',
        );
        if (confirm !== 'Complete') {
          return;
        }
        await mutate('Complete pull request', () =>
          api.git.updatePullRequest(pr, {
            status: 'completed',
            lastMergeSourceCommit: pr.lastMergeSourceCommit,
            completionOptions: {
              mergeStrategy: message.mergeStrategy as MergeStrategy,
              deleteSourceBranch: message.deleteSourceBranch,
              transitionWorkItems: message.transitionWorkItems,
              mergeCommitMessage: message.mergeCommitMessage,
            },
          }),
        );
        return;
      }
      case 'autoComplete':
        if (await write('set auto-complete')) {
          await mutate(message.enable ? 'Set auto-complete' : 'Cancel auto-complete', () =>
            api.git.updatePullRequest(
              pr,
              message.enable
                ? {
                    autoCompleteSetBy: { id: user.id },
                    completionOptions: {
                      mergeStrategy: message.mergeStrategy as MergeStrategy,
                      deleteSourceBranch: message.deleteSourceBranch,
                      transitionWorkItems: message.transitionWorkItems,
                    },
                  }
                : { autoCompleteSetBy: { id: ZERO_GUID } },
            ),
          );
        }
        return;
      case 'abandon': {
        if (!(await write('abandon pull requests'))) {
          return;
        }
        const confirm = await vscode.window.showWarningMessage(`Abandon pull request !${pr.pullRequestId}?`, { modal: true }, 'Abandon');
        if (confirm === 'Abandon') {
          await mutate('Abandon pull request', () => api.git.updatePullRequest(pr, { status: 'abandoned' }));
        }
        return;
      }
      case 'reactivate':
        if (await write('reactivate pull requests')) {
          await mutate('Reactivate pull request', () => api.git.updatePullRequest(pr, { status: 'active' }));
        }
        return;
      case 'publish':
        if (await write('publish pull requests')) {
          await mutate('Publish pull request', () => api.git.updatePullRequest(pr, { isDraft: false }));
        }
        return;
      case 'markDraft':
        if (await write('mark pull requests as draft')) {
          await mutate('Mark as draft', () => api.git.updatePullRequest(pr, { isDraft: true }));
        }
        return;
      case 'updateDetails':
        if (await write('edit pull requests')) {
          await mutate('Update pull request', () =>
            api.git.updatePullRequest(pr, {
              ...(message.title !== undefined ? { title: message.title } : {}),
              ...(message.description !== undefined ? { description: message.description } : {}),
            }),
          );
        }
        return;
      case 'addComment':
        if (message.text.trim() && (await write('comment on pull requests'))) {
          await mutate('Add comment', async () => {
            await api.git.createThread(pr, message.text);
            this.post({ type: 'commentPosted' });
          });
        }
        return;
      case 'reply':
        if (message.text.trim() && (await write('reply to comments'))) {
          await mutate('Reply', async () => {
            const thread = (await api.git.getThreads(pr, this.iterationId)).find(t => t.id === message.threadId);
            await api.git.reply(pr, message.threadId, message.text, thread?.comments[0]?.id ?? 1);
            this.post({ type: 'commentPosted' });
          });
        }
        return;
      case 'setThreadStatus':
        if (await write('resolve comment threads')) {
          await mutate('Update thread', () => api.git.setThreadStatus(pr, message.threadId, message.status as ThreadStatus));
        }
        return;
      case 'openFile': {
        const change = this.changes.find(c => c.item.path === message.path);
        if (change && this.iterationId !== undefined) {
          await vscode.commands.executeCommand('azureDevOps.pullRequests.openFileDiff', pr, change, this.iterationId, message.line);
        } else {
          void vscode.window.showInformationMessage(`${message.path} is not part of the latest iteration of this pull request.`);
        }
        return;
      }
      case 'openInBrowser':
        await vscode.env.openExternal(vscode.Uri.parse(api.git.webUrl(pr)));
        return;
      case 'copyLink':
        await vscode.env.clipboard.writeText(api.git.webUrl(pr));
        this.post({ type: 'toast', kind: 'info', message: 'Link copied' });
        return;
      case 'checkout':
        await vscode.commands.executeCommand('azureDevOps.pullRequests.checkout', pr);
        return;
      case 'addReviewer': {
        if (!(await write('add reviewers'))) {
          return;
        }
        const person = await pickReviewer(this.services, `Add reviewer to !${pr.pullRequestId}`);
        if (!person) {
          return;
        }
        const required = await vscode.window.showQuickPick(['Optional', 'Required'], { title: `Add ${person.displayName} as…` });
        if (required) {
          await mutate('Add reviewer', () => api.git.addReviewer(pr, person.id, required === 'Required'));
        }
        return;
      }
      case 'removeReviewer':
        if (await write('remove reviewers')) {
          await mutate('Remove reviewer', () => api.git.removeReviewer(pr, message.id));
        }
        return;
      case 'openWorkItem':
        WorkItemPanel.show(this.services, message.id);
        return;
      case 'linkWorkItem': {
        if (!(await this.services.access.ensure('vso.work_write', 'link work items to pull requests'))) {
          return;
        }
        const input = await vscode.window.showInputBox({
          title: `Link a work item to !${pr.pullRequestId}`,
          prompt: 'Work item ID',
          validateInput: v => (/^\d+$/.test(v.trim()) ? undefined : 'Enter a numeric work item ID'),
        });
        if (input) {
          await mutate('Link work item', () =>
            api.workItems.updateWorkItem(Number(input.trim()), [
              {
                op: 'add',
                path: '/relations/-',
                value: { rel: 'ArtifactLink', url: api.git.artifactUri(pr), attributes: { name: 'Pull Request' } },
              },
            ]),
          );
        }
        return;
      }
    }
  }

  private push(): void {
    const org = this.services.connections.connection?.organization;
    this.post({ type: 'state', state: { ...this.state, organization: org ? { url: org.url, name: org.name } : undefined } });
  }
}
