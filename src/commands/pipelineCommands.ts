import * as vscode from 'vscode';
import { shortRefName } from '../api/git';
import { BuildDefinitionReference } from '../api/types';
import { LogQuery, openLog } from '../providers/logContentProvider';
import { Services } from '../services';
import { ApprovalNode, DefinitionNode, PipelinesTree, ReleaseNode, RunNode, TimelineNode } from '../views/pipelinesTree';
import { parseVariables } from '../util/format';
import { registerCommand } from './register';

export function registerPipelineCommands(services: Services, tree: PipelinesTree): vscode.Disposable[] {
  const { connections, access } = services;

  const pickDefinition = async (): Promise<BuildDefinitionReference | undefined> => {
    const { api, project } = connections.requireProject();
    const definitions = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Loading pipelines…' }, () =>
      api.builds.listDefinitions(project),
    );
    const pick = await vscode.window.showQuickPick(
      definitions.map(d => ({ label: d.name, description: d.path === '\\' ? '' : d.path, definition: d })),
      { title: 'Run pipeline', placeHolder: 'Which pipeline?', matchOnDescription: true },
    );
    return pick?.definition;
  };

  const queue = async (definitionId: number, definitionName: string, branch?: string, askForInputs = true) => {
    if (!(await access.ensure('vso.build_execute', 'run pipelines'))) {
      return;
    }
    const { api, project, organization } = connections.requireProject();
    let sourceBranch = branch;
    const variables: Record<string, string> = {};
    const templateParameters: Record<string, string> = {};
    if (askForInputs) {
      const definition = await api.builds.getDefinition(project, definitionId);
      const remote = await services.git.findActiveRemote(organization);
      const localBranch =
        remote && definition.repository && remote.parsed.repository.toLowerCase() === definition.repository.name.toLowerCase()
          ? remote.repository.state.HEAD?.name
          : undefined;
      const value = await vscode.window.showInputBox({
        title: `Run ${definitionName} (1/2) — branch`,
        prompt: 'Branch to run',
        value: branch ? shortRefName(branch) : (localBranch ?? shortRefName(definition.repository?.defaultBranch)),
        validateInput: v => (v.trim() ? undefined : 'Enter a branch'),
      });
      if (!value) {
        return;
      }
      sourceBranch = value.startsWith('refs/') ? value.trim() : `refs/heads/${value.trim()}`;
      const overridable = Object.entries(definition.variables ?? {})
        .filter(([, v]) => v.allowOverride && !v.isSecret)
        .map(([name, v]) => `${name}=${v.value ?? ''}`);
      const inputs = await vscode.window.showInputBox({
        title: `Run ${definitionName} (2/2) — variables & parameters (optional)`,
        prompt:
          'Semicolon-separated name=value pairs. Prefix runtime parameters with "param:" (e.g. param:environment=staging). Leave empty to use defaults.',
        placeHolder: overridable.length ? overridable.join('; ') : 'name=value; param:name=value',
      });
      if (inputs === undefined) {
        return;
      }
      for (const [key, val] of Object.entries(parseVariables(inputs))) {
        if (key.startsWith('param:')) {
          templateParameters[key.slice(6)] = val;
        } else {
          variables[key] = val;
        }
      }
    }
    const build = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Queuing ${definitionName}…` },
      () => api.builds.queueBuild(project, { definitionId, sourceBranch, variables, templateParameters }),
    );
    tree.refresh();
    const open = 'Open in Browser';
    void vscode.window
      .showInformationMessage(`Queued ${definitionName} #${build.buildNumber} on ${shortRefName(build.sourceBranch)}`, open)
      .then(choice => {
        if (choice === open) {
          void vscode.env.openExternal(vscode.Uri.parse(build._links?.web?.href ?? api.builds.buildWebUrl(project, build.id)));
        }
      });
  };

  const decide = async (node: ApprovalNode, status: 'approved' | 'rejected') => {
    if (!(await access.ensure('vso.build_execute', status === 'approved' ? 'approve pipeline stages' : 'reject pipeline stages'))) {
      return;
    }
    const comment = await vscode.window.showInputBox({
      title: `${status === 'approved' ? 'Approve' : 'Reject'} ${node.approval.pipeline?.name ?? 'stage'}`,
      prompt: status === 'approved' ? 'Comment (optional)' : 'Reason (optional)',
    });
    if (comment === undefined) {
      return;
    }
    const { api } = connections.require();
    await api.builds.updateApproval(node.project, node.approval.id, status, comment);
    tree.refresh();
    vscode.window.setStatusBarMessage(`$(check) ${status === 'approved' ? 'Approved' : 'Rejected'}`, 4000);
  };

  return [
    registerCommand(services, 'azureDevOps.pipelines.refresh', 'refresh pipelines', () => tree.refresh()),
    registerCommand(services, 'azureDevOps.pipelines.run', 'run the pipeline', async (arg?: DefinitionNode | RunNode) => {
      if (!(await access.ensure('vso.build_execute', 'run pipelines'))) {
        return;
      }
      if (arg instanceof DefinitionNode) {
        await queue(arg.definition.id, arg.definition.name);
      } else if (arg instanceof RunNode) {
        await queue(arg.build.definition.id, arg.build.definition.name, arg.build.sourceBranch);
      } else {
        const definition = await pickDefinition();
        if (definition) {
          await queue(definition.id, definition.name);
        }
      }
    }),
    registerCommand(services, 'azureDevOps.pipelines.rerun', 'run the pipeline again', (node: RunNode) =>
      queue(node.build.definition.id, node.build.definition.name, node.build.sourceBranch, false),
    ),
    registerCommand(services, 'azureDevOps.pipelines.cancel', 'cancel the run', async (node: RunNode) => {
      if (!(await access.ensure('vso.build_execute', 'cancel pipeline runs'))) {
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Cancel ${node.build.definition.name} #${node.build.buildNumber}?`,
        { modal: true },
        'Cancel Run',
      );
      if (confirm === 'Cancel Run') {
        await connections.require().api.builds.cancelBuild(node.project, node.build.id);
        tree.refresh();
      }
    }),
    registerCommand(services, 'azureDevOps.pipelines.retry', 'retry the run', async (node: RunNode) => {
      if (!(await access.ensure('vso.build_execute', 'retry pipeline runs'))) {
        return;
      }
      await connections.require().api.builds.retryBuild(node.project, node.build.id);
      tree.refresh();
      vscode.window.setStatusBarMessage(`$(sync) Retrying failed jobs of #${node.build.buildNumber}`, 4000);
    }),
    registerCommand(services, 'azureDevOps.pipelines.openLog', 'open the log', (query: LogQuery | TimelineNode) => {
      if (query instanceof TimelineNode) {
        const record = query.node.record;
        if (!record.log) {
          return;
        }
        return openLog({
          project: query.project,
          buildId: query.build.id,
          logId: record.log.id,
          recordId: record.id,
          title: `${query.build.definition.name} #${query.build.buildNumber} — ${record.name}`,
        });
      }
      return openLog(query);
    }),
    registerCommand(
      services,
      'azureDevOps.pipelines.openInBrowser',
      'open in the browser',
      async (node: RunNode | DefinitionNode | ReleaseNode | ApprovalNode | TimelineNode) => {
        const { api } = connections.require();
        let url: string | undefined;
        if (node instanceof RunNode || node instanceof TimelineNode) {
          url = node.build._links?.web?.href ?? api.builds.buildWebUrl(node.project, node.build.id);
        } else if (node instanceof DefinitionNode) {
          url = api.builds.definitionWebUrl(node.project, node.definition.id);
        } else if (node instanceof ReleaseNode) {
          url = node.release._links?.web?.href ?? api.releases.releaseWebUrl(node.project, node.release.id);
        } else if (node instanceof ApprovalNode) {
          const owner = node.approval.pipeline?.owner;
          url = owner?._links?.web?.href ?? (owner ? api.builds.buildWebUrl(node.project, owner.id) : undefined);
        }
        if (url) {
          await vscode.env.openExternal(vscode.Uri.parse(url));
        }
      },
    ),
    registerCommand(services, 'azureDevOps.pipelines.approve', 'approve', (node: ApprovalNode) => decide(node, 'approved')),
    registerCommand(services, 'azureDevOps.pipelines.reject', 'reject', (node: ApprovalNode) => decide(node, 'rejected')),
  ];
}
