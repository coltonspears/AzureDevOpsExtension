import * as vscode from 'vscode';
import { AccessManager } from './auth/accessManager';
import { ConnectionManager } from './auth/connectionManager';
import { registerAuthCommands } from './commands/authCommands';
import { registerPipelineCommands } from './commands/pipelineCommands';
import { registerPullRequestCommands } from './commands/pullRequestCommands';
import { registerRepoCommands } from './commands/repoCommands';
import { registerWorkItemCommands } from './commands/workItemCommands';
import { GitIntegration } from './git/gitIntegration';
import { GIT_SCHEME, GitContentProvider } from './providers/gitContentProvider';
import { LOG_LANGUAGE, LOG_SCHEME, LogContentProvider, LogFoldingProvider } from './providers/logContentProvider';
import { PullRequestCommentController } from './providers/prCommentController';
import { Services } from './services';
import { initLogger, log } from './util/logger';
import { AccountStatusBar, AccountTree } from './views/accountTree';
import { PipelinesTree } from './views/pipelinesTree';
import { PullRequestsTree } from './views/pullRequestsTree';
import { WorkItemsTree } from './views/workItemsTree';
import { PullRequestPanel } from './webviews/pullRequestPanel';
import { WorkItemPanel } from './webviews/workItemPanel';

export function activate(context: vscode.ExtensionContext): void {
  initLogger(context);
  const access = new AccessManager(context.globalState);
  const git = new GitIntegration();
  const connections = new ConnectionManager(context, access, git);
  const services: Services = { context, connections, access, git };

  const accountTree = new AccountTree(services);
  const workItemsTree = new WorkItemsTree(services);
  const pullRequestsTree = new PullRequestsTree(services);
  const pipelinesTree = new PipelinesTree(services);

  const accountView = vscode.window.createTreeView('azureDevOps.account', { treeDataProvider: accountTree.provider });
  const workItemsView = vscode.window.createTreeView('azureDevOps.workItems', {
    treeDataProvider: workItemsTree.provider,
    showCollapseAll: true,
  });
  const pullRequestsView = vscode.window.createTreeView('azureDevOps.pullRequests', {
    treeDataProvider: pullRequestsTree.provider,
    showCollapseAll: true,
  });
  const pipelinesView = vscode.window.createTreeView('azureDevOps.pipelines', {
    treeDataProvider: pipelinesTree.provider,
    showCollapseAll: true,
  });
  pipelinesTree.setView(pipelinesView);

  const updateViewDescriptions = () => {
    const project = connections.project;
    for (const view of [workItemsView, pullRequestsView, pipelinesView]) {
      view.description = project;
    }
  };
  updateViewDescriptions();

  const comments = new PullRequestCommentController(services);
  const logs = new LogContentProvider(services);

  context.subscriptions.push(
    access,
    connections,
    accountTree,
    workItemsTree,
    pullRequestsTree,
    pipelinesTree,
    accountView,
    workItemsView,
    pullRequestsView,
    pipelinesView,
    comments,
    logs,
    new AccountStatusBar(services),
    connections.onDidChange(updateViewDescriptions),
    vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, new GitContentProvider(services)),
    vscode.workspace.registerTextDocumentContentProvider(LOG_SCHEME, logs),
    vscode.languages.registerFoldingRangeProvider({ language: LOG_LANGUAGE }, new LogFoldingProvider()),
    WorkItemPanel.onDidChangeWorkItem(() => workItemsTree.refresh()),
    PullRequestPanel.onDidChangePullRequest(() => pullRequestsTree.refresh()),
    comments.onDidChangeThreads(id => PullRequestPanel.refreshIfOpen(id)),
    ...registerAuthCommands(services),
    ...registerWorkItemCommands(services, workItemsTree),
    ...registerPullRequestCommands(services, pullRequestsTree, comments),
    ...registerPipelineCommands(services, pipelinesTree),
    ...registerRepoCommands(services),
  );

  connections.initialize().catch(error => log.error('Initialization failed', error));
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}
