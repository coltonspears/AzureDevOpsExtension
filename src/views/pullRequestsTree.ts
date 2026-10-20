import * as path from 'path';
import * as vscode from 'vscode';
import { GitPullRequest, PullRequestChange } from '../api/types';
import { shortRefName, voteLabel } from '../api/git';
import { Services } from '../services';
import { relativeTime } from '../util/format';
import { pullRequestIcon, voteIcon } from './icons';
import { GroupNode, MessageNode, NodeTreeProvider, TreeNode } from './treeNodes';

export function changeTypeLabel(changeType: string): { letter: string; label: string } {
  const type = changeType.toLowerCase();
  if (type.includes('add')) {
    return { letter: 'A', label: 'Added' };
  }
  if (type.includes('delete')) {
    return { letter: 'D', label: 'Deleted' };
  }
  if (type.includes('rename') && !type.includes('edit')) {
    return { letter: 'R', label: 'Renamed' };
  }
  if (type.includes('rename')) {
    return { letter: 'R', label: 'Renamed & edited' };
  }
  return { letter: 'M', label: 'Modified' };
}

export class PullRequestNode extends TreeNode {
  constructor(
    readonly pullRequest: GitPullRequest,
    private readonly services: Services,
    private readonly parentId: string,
  ) {
    super();
  }

  getTreeItem(): vscode.TreeItem {
    const pr = this.pullRequest;
    const item = new vscode.TreeItem(pr.title, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `${this.parentId}/pr:${pr.pullRequestId}`;
    item.description = `!${pr.pullRequestId} · ${pr.repository.name} · ${shortRefName(pr.sourceRefName)} → ${shortRefName(pr.targetRefName)}`;
    item.iconPath = pullRequestIcon(pr);
    item.contextValue = `pullRequest:${pr.status}${pr.isDraft ? ':draft' : ''}`;

    const userId = this.services.connections.connection?.user.id;
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown(`**!${pr.pullRequestId} ${escape(pr.title)}**${pr.isDraft ? ' _(draft)_' : ''}\n\n`);
    tooltip.appendMarkdown(`${pr.repository.name}: \`${shortRefName(pr.sourceRefName)}\` → \`${shortRefName(pr.targetRefName)}\`\n\n`);
    tooltip.appendMarkdown(`Created by ${pr.createdBy.displayName} ${relativeTime(pr.creationDate)}\n\n`);
    if (pr.mergeStatus === 'conflicts') {
      tooltip.appendMarkdown('$(warning) Merge conflicts\n\n');
    }
    for (const reviewer of pr.reviewers) {
      const me = reviewer.id === userId ? ' (you)' : '';
      tooltip.appendMarkdown(`${voteIcon(reviewer.vote)} ${escape(reviewer.displayName)}${me} — ${voteLabel(reviewer.vote)}${reviewer.isRequired ? ' · required' : ''}\n\n`);
    }
    item.tooltip = tooltip;
    return item;
  }

  override async getChildren(): Promise<TreeNode[]> {
    const { api } = this.services.connections.require();
    const pr = this.pullRequest;
    const iterations = await api.git.getIterations(pr);
    const latest = iterations[iterations.length - 1];
    const nodes: TreeNode[] = [
      new MessageNode('Overview, comments & actions', 'preview', {
        command: 'azureDevOps.pullRequests.open',
        title: 'Open Pull Request',
        arguments: [this],
      }),
    ];
    if (!latest) {
      return nodes;
    }
    const changes = await api.git.getChanges(pr, latest.id);
    if (!changes.length) {
      nodes.push(new MessageNode('No file changes', 'info'));
    }
    for (const change of changes.sort((a, b) => a.item.path.localeCompare(b.item.path))) {
      nodes.push(new PullRequestFileNode(pr, change, latest.id, `${this.parentId}/pr:${pr.pullRequestId}`));
    }
    return nodes;
  }
}

export class PullRequestFileNode extends TreeNode {
  constructor(
    readonly pullRequest: GitPullRequest,
    readonly change: PullRequestChange,
    readonly iterationId: number,
    private readonly parentId: string,
  ) {
    super();
  }

  getTreeItem(): vscode.TreeItem {
    const filePath = this.change.item.path;
    const { letter, label } = changeTypeLabel(this.change.changeType);
    const item = new vscode.TreeItem(path.posix.basename(filePath));
    item.id = `${this.parentId}/file:${filePath}`;
    const dir = path.posix.dirname(filePath).replace(/^\//, '');
    item.description = `${letter}${dir ? ` · ${dir}` : ''}`;
    item.tooltip = `${label}: ${filePath}${this.change.originalPath ? `\nfrom ${this.change.originalPath}` : ''}`;
    // A file-scheme uri lets the active file icon theme pick the icon.
    item.resourceUri = vscode.Uri.file(filePath);
    item.contextValue = 'pullRequestFile';
    item.command = {
      command: 'azureDevOps.pullRequests.openFileDiff',
      title: 'Open Diff',
      arguments: [this.pullRequest, this.change, this.iterationId],
    };
    return item;
  }
}

type PullRequestCriteria = { creatorId?: string; reviewerId?: string; status?: 'completed'; top?: number };

function escape(text: string): string {
  return text.replace(/[\\`*_{}[\]<>|]/g, '\\$&');
}

export class PullRequestsTree implements vscode.Disposable {
  readonly provider: NodeTreeProvider;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly services: Services) {
    this.provider = new NodeTreeProvider(() => this.roots(), 'Pull requests');
    let lastDenied = services.access.isDenied('vso.code');
    this.disposables.push(
      this.provider,
      services.connections.onDidChange(() => this.refresh()),
      services.access.onDidChange(() => {
        const denied = services.access.isDenied('vso.code');
        if (denied !== lastDenied) {
          lastDenied = denied;
          this.refresh();
        }
      }),
    );
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }

  refresh(): void {
    this.provider.refresh();
  }

  private async roots(): Promise<TreeNode[]> {
    const { connections, access } = this.services;
    if (!connections.isSignedIn || !connections.project || access.isDenied('vso.code')) {
      return [];
    }
    const userId = connections.connection?.user.id;
    const group = (key: string, label: string, icon: string, search: () => Promise<GitPullRequest[]>, expanded = false) =>
      new GroupNode(
        `pr:${key}`,
        label,
        async () => (await search()).map(pr => new PullRequestNode(pr, this.services, `pr:${key}`)),
        { icon, expanded, what: label, emptyMessage: 'No pull requests' },
      );
    const search = (criteria: PullRequestCriteria) => () => this.search(criteria);
    return [
      group('mine', 'Created by Me', 'account', search({ creatorId: userId }), true),
      group('review', 'Assigned to Me', 'eye', search({ reviewerId: userId }), true),
      group('active', 'All Active', 'git-pull-request', search({})),
      group('completed', 'Recently Completed', 'git-merge', search({ status: 'completed', top: 25 })),
    ];
  }

  private async search(criteria: PullRequestCriteria): Promise<GitPullRequest[]> {
    const { api, project } = this.services.connections.requireProject();
    return api.git.searchPullRequests(project, { status: 'active', ...criteria });
  }
}
