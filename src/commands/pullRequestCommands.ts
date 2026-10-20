import * as path from 'path';
import * as vscode from 'vscode';
import { VOTES, shortRefName, voteLabel } from '../api/git';
import { GitPullRequest, PullRequestChange } from '../api/types';
import { gitFileUri, parseGitFileUri } from '../providers/gitContentProvider';
import { PullRequestCommentController } from '../providers/prCommentController';
import { Services } from '../services';
import { CreatePullRequestPanel } from '../webviews/createPullRequestPanel';
import { PullRequestPanel } from '../webviews/pullRequestPanel';
import { PullRequestNode, PullRequestsTree, changeTypeLabel } from '../views/pullRequestsTree';
import { registerCommand } from './register';

type PullRequestArg = PullRequestNode | GitPullRequest | number | undefined;

async function resolvePullRequest(services: Services, arg: PullRequestArg): Promise<GitPullRequest | undefined> {
  if (arg instanceof PullRequestNode) {
    return arg.pullRequest;
  }
  if (arg && typeof arg === 'object' && 'pullRequestId' in arg) {
    return arg;
  }
  let id = typeof arg === 'number' ? arg : undefined;
  if (id === undefined) {
    const value = await vscode.window.showInputBox({
      title: 'Open pull request',
      prompt: 'Pull request ID',
      validateInput: v => (/^!?\d+$/.test(v.trim()) ? undefined : 'Enter a numeric pull request ID'),
    });
    if (!value) {
      return undefined;
    }
    id = Number(value.trim().replace('!', ''));
  }
  return services.connections.require().api.git.getPullRequest(id);
}

export function registerPullRequestCommands(
  services: Services,
  tree: PullRequestsTree,
  comments: PullRequestCommentController,
): vscode.Disposable[] {
  const { connections, access } = services;

  const openPanel = (id: number) => PullRequestPanel.show(services, id, (pr, threads) => void comments.load(pr, threads));

  const openFileDiff = async (pr: GitPullRequest, change: PullRequestChange, iterationId: number, line?: number) => {
    const project = pr.repository.project.id;
    const repositoryId = pr.repository.id;
    const type = change.changeType.toLowerCase();
    const originalPath = change.originalPath ?? change.sourceServerItem ?? change.item.path;
    const common = { project, repositoryId, pullRequestId: pr.pullRequestId, changeTrackingId: change.changeTrackingId, iterationId };
    const left = gitFileUri({
      ...common,
      objectId: type.includes('add') ? '' : (change.item.originalObjectId ?? ''),
      path: originalPath,
      side: 'left',
    });
    const right = gitFileUri({
      ...common,
      objectId: type.includes('delete') ? '' : (change.item.objectId ?? ''),
      path: change.item.path,
      side: 'right',
    });
    // Make sure comment threads are available for the documents about to open.
    await comments.load(pr).catch(() => undefined);
    const { label } = changeTypeLabel(change.changeType);
    const title = `${path.posix.basename(change.item.path)} (!${pr.pullRequestId} · ${label})`;
    const options: vscode.TextDocumentShowOptions = { preview: true };
    if (line && line > 0) {
      options.selection = new vscode.Range(line - 1, 0, line - 1, 0);
    }
    await vscode.commands.executeCommand('vscode.diff', left, right, title, options);
  };

  const vote = async (arg: PullRequestArg, value?: number) => {
    const pr = await resolvePullRequest(services, arg);
    if (!pr || !(await access.ensure('vso.code_write', 'vote on pull requests'))) {
      return;
    }
    let chosen = value;
    if (chosen === undefined) {
      const pick = await vscode.window.showQuickPick(
        [
          { label: '$(pass-filled) Approve', vote: VOTES.approve },
          { label: '$(pass) Approve with suggestions', vote: VOTES.approveWithSuggestions },
          { label: '$(clock) Wait for author', vote: VOTES.waitForAuthor },
          { label: '$(error) Reject', vote: VOTES.reject },
          { label: '$(discard) Reset feedback', vote: VOTES.reset },
        ],
        { title: `Vote on !${pr.pullRequestId}: ${pr.title}` },
      );
      chosen = pick?.vote;
    }
    if (chosen === undefined) {
      return;
    }
    const { api, user } = connections.require();
    await api.git.vote(pr, user.id, chosen);
    tree.refresh();
    PullRequestPanel.refreshIfOpen(pr.pullRequestId);
    vscode.window.setStatusBarMessage(`$(check) !${pr.pullRequestId}: ${voteLabel(chosen)}`, 4000);
  };

  return [
    registerCommand(services, 'azureDevOps.pullRequests.refresh', 'refresh pull requests', () => tree.refresh()),
    registerCommand(services, 'azureDevOps.pullRequests.create', 'create a pull request', () => {
      connections.require();
      CreatePullRequestPanel.show(services);
    }),
    registerCommand(services, 'azureDevOps.pullRequests.open', 'open the pull request', async (arg: PullRequestArg) => {
      if (typeof arg === 'number') {
        openPanel(arg);
        return;
      }
      const pr = await resolvePullRequest(services, arg);
      if (pr) {
        openPanel(pr.pullRequestId);
      }
    }),
    registerCommand(services, 'azureDevOps.pullRequests.openInBrowser', 'open the pull request', async (arg: PullRequestArg) => {
      const pr = await resolvePullRequest(services, arg);
      if (pr) {
        await vscode.env.openExternal(vscode.Uri.parse(connections.require().api.git.webUrl(pr)));
      }
    }),
    registerCommand(services, 'azureDevOps.pullRequests.copyLink', 'copy the link', async (arg: PullRequestArg) => {
      const pr = await resolvePullRequest(services, arg);
      if (pr) {
        await vscode.env.clipboard.writeText(connections.require().api.git.webUrl(pr));
        vscode.window.setStatusBarMessage(`$(check) Copied link to !${pr.pullRequestId}`, 3000);
      }
    }),
    registerCommand(services, 'azureDevOps.pullRequests.vote', 'vote', (arg: PullRequestArg) => vote(arg)),
    registerCommand(services, 'azureDevOps.pullRequests.approve', 'approve', (arg: PullRequestArg) => vote(arg, VOTES.approve)),
    registerCommand(
      services,
      'azureDevOps.pullRequests.openFileDiff',
      'open the diff',
      (pr: GitPullRequest, change: PullRequestChange, iterationId: number, line?: number) => openFileDiff(pr, change, iterationId, line),
    ),
    registerCommand(services, 'azureDevOps.pullRequests.checkout', 'check out the branch', async (arg: PullRequestArg) => {
      const pr = await resolvePullRequest(services, arg);
      if (!pr) {
        return;
      }
      const { organization } = connections.require();
      const clone = await services.git.findLocalClone(pr.repository.project.name, pr.repository.name, organization);
      if (!clone) {
        const cloneIt = 'Clone Repository';
        const choice = await vscode.window.showWarningMessage(
          `${pr.repository.name} is not open in this workspace. Open or clone it to check out ${shortRefName(pr.sourceRefName)}.`,
          cloneIt,
        );
        if (choice === cloneIt) {
          await vscode.commands.executeCommand('azureDevOps.repos.clone', pr.repository);
        }
        return;
      }
      const branch = shortRefName(pr.sourceRefName);
      const { repository, remote } = clone;
      if (repository.state.workingTreeChanges.length || repository.state.indexChanges.length) {
        const proceed = await vscode.window.showWarningMessage(
          'You have uncommitted changes. Checking out another branch may fail or carry them over.',
          { modal: true },
          'Check Out Anyway',
        );
        if (proceed !== 'Check Out Anyway') {
          return;
        }
      }
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Checking out ${branch}…` }, async () => {
        await repository.fetch(remote.name, branch);
        const exists = await repository.getBranch(branch).then(
          () => true,
          () => false,
        );
        if (exists) {
          await repository.checkout(branch);
          await repository.pull().catch(() => undefined);
        } else {
          await repository.createBranch(branch, true, `${remote.name}/${branch}`);
        }
      });
      vscode.window.setStatusBarMessage(`$(git-branch) Checked out ${branch} for !${pr.pullRequestId}`, 5000);
    }),
    registerCommand(services, 'azureDevOps.pullRequests.openFile', 'open the file', async (uri?: vscode.Uri) => {
      // Opens the workspace copy of a file shown in a pull request diff.
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      const query = target ? parseGitFileUri(target) : undefined;
      if (!query) {
        return;
      }
      const filePath = query.path.replace(/^\//, '');
      const matches = await vscode.workspace.findFiles(filePath, undefined, 1);
      if (matches[0]) {
        await vscode.window.showTextDocument(matches[0]);
      } else {
        void vscode.window.showInformationMessage(`${filePath} was not found in the workspace.`);
      }
    }),
  ];
}
