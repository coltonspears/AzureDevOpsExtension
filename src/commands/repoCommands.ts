import * as path from 'path';
import * as vscode from 'vscode';
import { GitRepository } from '../api/types';
import { fileWebUrl } from '../api/urls';
import { Services } from '../services';
import { registerCommand } from './register';

export function registerRepoCommands(services: Services): vscode.Disposable[] {
  const { connections } = services;

  const currentFileUrl = async (): Promise<string | undefined> => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      void vscode.window.showInformationMessage('Open a file from an Azure Repos clone first.');
      return undefined;
    }
    const { api } = connections.require();
    const repository = await services.git.repositoryFor(editor.document.uri);
    const remotes = (await services.git.findAzureRemotes()).filter(r => r.repository === repository);
    const remote = remotes.find(r => r.remote.name === 'origin') ?? remotes[0];
    if (!repository || !remote) {
      void vscode.window.showInformationMessage('This file is not in a repository with an Azure Repos remote.');
      return undefined;
    }
    const relative = path.relative(repository.rootUri.fsPath, editor.document.uri.fsPath).split(path.sep).join('/');
    const selection = editor.selection;
    const base = api.git.repositoryWebUrl(remote.parsed.project, remote.parsed.repository);
    return fileWebUrl(base, relative, repository.state.HEAD?.upstream?.name ?? repository.state.HEAD?.name, {
      startLine: selection.start.line + 1,
      endLine: selection.end.line + 1,
      endColumn: selection.end.character + 1,
    });
  };

  return [
    registerCommand(services, 'azureDevOps.repos.clone', 'clone the repository', async (preselected?: GitRepository) => {
      const { api, project } = connections.requireProject();
      let repository = preselected;
      if (!repository?.remoteUrl) {
        const repositories = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Loading repositories…' }, () =>
          api.git.listRepositories(project),
        );
        const pick = await vscode.window.showQuickPick(
          repositories.map(r => ({
            label: `$(repo) ${r.name}`,
            description: r.defaultBranch?.replace('refs/heads/', ''),
            detail: r.size ? `${(r.size / 1024 / 1024).toFixed(1)} MB` : undefined,
            repository: r,
          })),
          { title: `Clone a repository from ${project}`, placeHolder: 'Repository' },
        );
        repository = pick?.repository;
      }
      if (!repository?.remoteUrl) {
        return;
      }
      const protocol = vscode.workspace.getConfiguration('azureDevOps.repos').get<string>('cloneProtocol', 'https');
      const url = protocol === 'ssh' && repository.sshUrl ? repository.sshUrl : repository.remoteUrl;
      await vscode.commands.executeCommand('git.clone', url);
    }),
    registerCommand(services, 'azureDevOps.repos.openFileInBrowser', 'open the file in Azure Repos', async () => {
      const url = await currentFileUrl();
      if (url) {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      }
    }),
    registerCommand(services, 'azureDevOps.repos.copyFileLink', 'copy the link', async () => {
      const url = await currentFileUrl();
      if (url) {
        await vscode.env.clipboard.writeText(url);
        vscode.window.setStatusBarMessage('$(check) Copied Azure Repos link', 3000);
      }
    }),
  ];
}
