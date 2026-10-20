import * as vscode from 'vscode';
import { shortRefName } from '../api/git';
import { GitRepository } from '../api/types';
import { pickReviewer } from '../commands/people';
import { AzureRemote } from '../git/gitIntegration';
import { Services } from '../services';
import { CreatePullRequestToHost, CreatePullRequestToWebview, CreatePullRequestViewState } from '../shared/messages';
import { findWorkItemReferences, titleFromBranch } from '../util/format';
import { log } from '../util/logger';
import { summarizeWorkItem } from '../views/workItemsTree';
import { WebviewPanelBase } from './panelBase';
import { PullRequestPanel } from './pullRequestPanel';

export class CreatePullRequestPanel extends WebviewPanelBase<CreatePullRequestToHost, CreatePullRequestToWebview> {
  private static current?: CreatePullRequestPanel;
  private repositories: GitRepository[] = [];
  private remote?: AzureRemote;
  private state: CreatePullRequestViewState = {
    loading: true,
    canCreate: 'unknown',
    repositories: [],
    branches: [],
    title: '',
    description: '',
    isDraft: false,
    reviewers: [],
    workItems: [],
    commits: [],
    creating: false,
  };
  /** Title/description the user has not edited yet are regenerated when branches change. */
  private generated = { title: '', description: '' };

  static show(services: Services): void {
    if (CreatePullRequestPanel.current && !CreatePullRequestPanel.current.disposed) {
      CreatePullRequestPanel.current.reveal();
      return;
    }
    CreatePullRequestPanel.current = new CreatePullRequestPanel(services);
  }

  private constructor(services: Services) {
    super(services, 'azureDevOps.createPullRequest', 'New Pull Request', 'createPullRequest');
    this.track(
      services.access.onDidChange(() => {
        this.state = { ...this.state, canCreate: services.access.get('vso.code_write') };
        this.push();
      }),
    );
  }

  protected async onReady(): Promise<void> {
    await this.initialize();
  }

  private async initialize(): Promise<void> {
    const { api, organization } = this.services.connections.require();
    const project = this.services.connections.project;
    this.state = { ...this.state, loading: true, error: undefined, canCreate: this.services.access.get('vso.code_write') };
    this.push();
    try {
      this.remote = await this.services.git.findActiveRemote(organization);
      const repositories = project ? await api.git.listRepositories(project) : [];
      if (this.remote && !repositories.some(r => r.name.toLowerCase() === this.remote!.parsed.repository.toLowerCase())) {
        const remoteRepo = await api.git.getRepository(this.remote.parsed.project, this.remote.parsed.repository).catch(() => undefined);
        if (remoteRepo) {
          repositories.unshift(remoteRepo);
        }
      }
      this.repositories = repositories;
      if (!repositories.length) {
        throw new Error(project ? `No repositories found in ${project}.` : 'Select a project first.');
      }
      const preferred =
        repositories.find(r => this.remote && r.name.toLowerCase() === this.remote.parsed.repository.toLowerCase()) ?? repositories[0];
      this.state = { ...this.state, repositories: repositories.map(r => ({ id: r.id, name: r.name })) };
      await this.selectRepository(preferred.id, true);
    } catch (error) {
      this.state = { ...this.state, loading: false, error: error instanceof Error ? error.message : String(error) };
      this.push();
    }
  }

  private repository(): GitRepository | undefined {
    return this.repositories.find(r => r.id === this.state.repositoryId);
  }

  private async selectRepository(repositoryId: string, initial = false): Promise<void> {
    const { api } = this.services.connections.require();
    const repository = this.repositories.find(r => r.id === repositoryId);
    if (!repository) {
      return;
    }
    this.state = { ...this.state, repositoryId, loading: true };
    this.push();
    const branches = (await api.git.listBranches(repository.project.name, repository.id)).sort((a, b) => a.localeCompare(b));
    const isLocalRepo = this.remote && repository.name.toLowerCase() === this.remote.parsed.repository.toLowerCase();
    const head = isLocalRepo ? this.remote!.repository.state.HEAD : undefined;
    const target = shortRefName(repository.defaultBranch) || branches[0];
    const source =
      head?.name && head.name !== target ? head.name : initial ? branches.find(b => b !== target) : this.state.source;
    this.state = {
      ...this.state,
      branches,
      target,
      source,
      localBranch: head?.name
        ? { name: head.name, unpublished: !head.upstream || !branches.includes(head.name), ahead: head.ahead ?? 0 }
        : undefined,
    };
    await this.selectBranches(source, target);
  }

  private async selectBranches(source: string | undefined, target: string | undefined): Promise<void> {
    const { api } = this.services.connections.require();
    const repository = this.repository();
    this.state = { ...this.state, source, target, loading: false, existing: undefined, commits: [] };
    if (!repository || !source || !target || source === target || !this.state.branches.includes(source)) {
      this.push();
      return;
    }
    this.push();
    const project = repository.project.name;
    const [commits, existing] = await Promise.all([
      api.git.getCommitsBetween(project, repository.id, source, target).catch(error => {
        log.warn(`Comparing branches failed: ${String(error)}`);
        return [];
      }),
      api.git
        .searchPullRequests(project, {
          repositoryId: repository.id,
          sourceRefName: `refs/heads/${source}`,
          targetRefName: `refs/heads/${target}`,
          status: 'active',
          top: 1,
        })
        .catch(() => []),
    ]);
    const messages = commits.map(c => (c.comment ?? '').trim()).filter(Boolean);
    const title = messages.length === 1 ? messages[0].split('\n')[0] : titleFromBranch(source);
    const description = messages.length > 1 ? messages.map(m => `- ${m.split('\n')[0]}`).join('\n') : messages[0]?.split('\n').slice(1).join('\n').trim() ?? '';
    const ids = findWorkItemReferences([source, ...messages].join('\n')).slice(0, 20);
    const linked = ids.length && this.services.access.get('vso.work') !== 'denied' ? await api.workItems.getWorkItems(ids).catch(() => []) : [];
    const known = new Set(this.state.workItems.map(w => w.id));
    const workItems = [
      ...this.state.workItems,
      ...linked.map(summarizeWorkItem).filter(w => !known.has(w.id)).map(w => ({ id: w.id, title: w.title })),
    ];
    this.state = {
      ...this.state,
      commits: commits.map(c => ({ id: c.commitId, message: (c.comment ?? '').split('\n')[0] })),
      existing: existing[0] ? { id: existing[0].pullRequestId, title: existing[0].title } : undefined,
      title: !this.state.title || this.state.title === this.generated.title ? title : this.state.title,
      description: !this.state.description || this.state.description === this.generated.description ? description : this.state.description,
      workItems,
    };
    this.generated = { title, description };
    this.push();
  }

  protected async onMessage(message: CreatePullRequestToHost): Promise<void> {
    const { api } = this.services.connections.require();
    switch (message.type) {
      case 'refresh':
        await this.initialize();
        return;
      case 'selectRepository':
        await this.selectRepository(message.repositoryId);
        return;
      case 'selectBranches':
        await this.selectBranches(message.source, message.target);
        return;
      case 'addReviewer': {
        const person = await pickReviewer(this.services, 'Add a reviewer');
        if (person && !this.state.reviewers.some(r => r.id === person.id)) {
          this.state = { ...this.state, reviewers: [...this.state.reviewers, { id: person.id, name: person.displayName }] };
          this.push();
        }
        return;
      }
      case 'removeReviewer':
        this.state = { ...this.state, reviewers: this.state.reviewers.filter(r => r.id !== message.id) };
        this.push();
        return;
      case 'addWorkItem': {
        const input = await vscode.window.showInputBox({
          title: 'Link a work item',
          prompt: 'Work item ID',
          validateInput: v => (/^\d+$/.test(v.trim()) ? undefined : 'Enter a numeric work item ID'),
        });
        if (!input) {
          return;
        }
        const id = Number(input.trim());
        const [item] = await api.workItems.getWorkItems([id]).catch(() => []);
        if (!this.state.workItems.some(w => w.id === id)) {
          this.state = {
            ...this.state,
            workItems: [...this.state.workItems, { id, title: item ? summarizeWorkItem(item).title : `Work item ${id}` }],
          };
          this.push();
        }
        return;
      }
      case 'removeWorkItem':
        this.state = { ...this.state, workItems: this.state.workItems.filter(w => w.id !== message.id) };
        this.push();
        return;
      case 'pushBranch':
        await this.pushBranch();
        return;
      case 'openExisting':
        if (this.state.existing) {
          PullRequestPanel.show(this.services, this.state.existing.id);
        }
        return;
      case 'create':
        await this.create(message);
        return;
    }
  }

  private async pushBranch(): Promise<void> {
    const remote = this.remote;
    const branch = remote?.repository.state.HEAD?.name;
    if (!remote || !branch) {
      return;
    }
    await this.run(`Push ${branch}`, async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Pushing ${branch} to ${remote.remote.name}…` },
        () => remote.repository.push(remote.remote.name, branch, true),
      );
      if (this.state.repositoryId) {
        await this.selectRepository(this.state.repositoryId);
      }
    });
  }

  private async create(message: Extract<CreatePullRequestToHost, { type: 'create' }>): Promise<void> {
    const repository = this.repository();
    const { source, target } = this.state;
    if (!repository || !source || !target) {
      return;
    }
    if (!(await this.services.access.ensure('vso.code_write', 'create pull requests'))) {
      return;
    }
    if (!message.title.trim()) {
      this.post({ type: 'toast', kind: 'error', message: 'A title is required' });
      return;
    }
    this.state = { ...this.state, creating: true, title: message.title, description: message.description, isDraft: message.isDraft };
    this.push();
    await this.run('Create pull request', async () => {
      const { api, user } = this.services.connections.require();
      const pr = await api.git.createPullRequest(repository.project.name, repository.id, {
        sourceRefName: `refs/heads/${source}`,
        targetRefName: `refs/heads/${target}`,
        title: message.title.trim(),
        description: message.description,
        isDraft: message.isDraft,
        reviewers: this.state.reviewers.map(r => ({ id: r.id })),
        workItemRefs: this.state.workItems.map(w => ({ id: String(w.id) })),
      });
      if (message.autoComplete && !message.isDraft) {
        const config = vscode.workspace.getConfiguration('azureDevOps.pullRequests');
        await api.git
          .updatePullRequest(pr, {
            autoCompleteSetBy: { id: user.id },
            completionOptions: {
              mergeStrategy: config.get('defaultMergeStrategy', 'squash'),
              deleteSourceBranch: config.get('deleteSourceBranch', true),
              transitionWorkItems: config.get('transitionWorkItems', true),
            },
          })
          .catch(error => log.warn(`Setting auto-complete failed: ${String(error)}`));
      }
      await vscode.commands.executeCommand('azureDevOps.pullRequests.refresh');
      const open = 'Open in Browser';
      void vscode.window.showInformationMessage(`Created pull request !${pr.pullRequestId}: ${pr.title}`, open).then(choice => {
        if (choice === open) {
          void vscode.env.openExternal(vscode.Uri.parse(api.git.webUrl(pr)));
        }
      });
      PullRequestPanel.show(this.services, pr.pullRequestId);
      this.dispose();
    });
    if (!this.disposed) {
      this.state = { ...this.state, creating: false };
      this.push();
    }
  }

  private push(): void {
    this.post({ type: 'state', state: this.state });
  }
}
