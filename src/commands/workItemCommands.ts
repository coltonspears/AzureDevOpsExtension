import * as path from 'path';
import * as vscode from 'vscode';
import { JsonPatchOperation, WorkItemType } from '../api/types';
import { Services } from '../services';
import { branchNameFor, escapeHtml, htmlToText, wiqlString } from '../util/format';
import { workItemMarkdown } from '../util/workItemMarkdown';
import { WorkItemPanel } from '../webviews/workItemPanel';
import { RELATION_TYPES } from '../webviews/workItemFields';
import { WorkItemNode, WorkItemsTree, summarizeWorkItem } from '../views/workItemsTree';
import { workItemTypeIcon } from '../views/icons';
import { pickPerson } from './people';
import { registerCommand } from './register';

type WorkItemArg = WorkItemNode | number | { id: number } | undefined;

const COMMON_TYPES = ['User Story', 'Product Backlog Item', 'Requirement', 'Issue', 'Bug', 'Task', 'Feature', 'Epic'];

function idFrom(arg: WorkItemArg): number | undefined {
  if (arg instanceof WorkItemNode) {
    return arg.item.id;
  }
  if (typeof arg === 'number') {
    return arg;
  }
  if (arg && typeof arg === 'object' && typeof arg.id === 'number') {
    return arg.id;
  }
  return undefined;
}

async function promptForId(title: string): Promise<number | undefined> {
  const value = await vscode.window.showInputBox({
    title,
    prompt: 'Work item ID',
    validateInput: v => (/^#?\d+$/.test(v.trim()) ? undefined : 'Enter a numeric work item ID'),
  });
  return value ? Number(value.trim().replace('#', '')) : undefined;
}

export function registerWorkItemCommands(services: Services, tree: WorkItemsTree): vscode.Disposable[] {
  const { connections, access } = services;

  const resolveId = async (arg: WorkItemArg, title: string) => idFrom(arg) ?? (await promptForId(title));

  const update = async (id: number, operations: JsonPatchOperation[]) => {
    const { api } = connections.require();
    const updated = await api.workItems.updateWorkItem(id, operations);
    tree.refresh();
    WorkItemPanel.refreshIfOpen(id);
    return updated;
  };

  const pickType = async (project: string): Promise<WorkItemType | undefined> => {
    const { api } = connections.require();
    const types = await api.workItems.getCreatableTypes(project);
    const rank = (t: WorkItemType) => {
      const index = COMMON_TYPES.indexOf(t.name);
      return index === -1 ? COMMON_TYPES.length : index;
    };
    const pick = await vscode.window.showQuickPick(
      types
        .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
        .map(t => ({ label: t.name, description: t.description?.slice(0, 80), iconPath: workItemTypeIcon(t.name), type: t })),
      { title: 'New work item — type', placeHolder: 'What kind of work item?' },
    );
    return pick?.type;
  };

  const create = async (options: { parentId?: number; description?: string; title?: string } = {}) => {
    if (!(await access.ensure('vso.work_write', 'create work items'))) {
      return;
    }
    const { api, project } = connections.requireProject();
    const type = await pickType(project);
    if (!type) {
      return;
    }
    const title = await vscode.window.showInputBox({
      title: `New ${type.name}${options.parentId ? ` (child of ${options.parentId})` : ''}`,
      prompt: 'Title',
      value: options.title,
      validateInput: v => (v.trim() ? undefined : 'A title is required'),
    });
    if (!title) {
      return;
    }
    const config = vscode.workspace.getConfiguration('azureDevOps.workItems');
    const operations: JsonPatchOperation[] = [{ op: 'add', path: '/fields/System.Title', value: title.trim() }];
    if (config.get<boolean>('assignNewToMe', true)) {
      const user = connections.require().user;
      operations.push({ op: 'add', path: '/fields/System.AssignedTo', value: user.email ?? user.displayName });
    }
    if (config.get<boolean>('createInCurrentIteration', false)) {
      const iteration = await api.workItems.getCurrentIteration(project, connections.team).catch(() => undefined);
      if (iteration) {
        operations.push({ op: 'add', path: '/fields/System.IterationPath', value: iteration.path });
      }
    }
    if (options.description) {
      const field = type.name === 'Bug' ? 'Microsoft.VSTS.TCM.ReproSteps' : 'System.Description';
      operations.push({ op: 'add', path: `/fields/${field}`, value: options.description });
    }
    if (options.parentId) {
      operations.push({
        op: 'add',
        path: '/relations/-',
        value: { rel: RELATION_TYPES.parent, url: api.workItems.apiUrl(options.parentId) },
      });
    }
    const created = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Creating ${type.name}…` },
      () => api.workItems.createWorkItem(project, type.name, operations),
    );
    tree.refresh();
    if (options.parentId) {
      WorkItemPanel.refreshIfOpen(options.parentId);
    }
    WorkItemPanel.show(services, created.id);
    void vscode.window.showInformationMessage(`Created ${type.name} ${created.id}: ${title.trim()}`);
  };

  return [
    registerCommand(services, 'azureDevOps.workItems.refresh', 'refresh work items', () => tree.refresh()),
    registerCommand(services, 'azureDevOps.workItems.open', 'open the work item', async (arg: WorkItemArg) => {
      const id = await resolveId(arg, 'Open work item');
      if (id) {
        WorkItemPanel.show(services, id);
      }
    }),
    registerCommand(services, 'azureDevOps.workItems.search', 'search work items', async () => {
      const { api, project } = connections.requireProject();
      const pick = vscode.window.createQuickPick<vscode.QuickPickItem & { id: number }>();
      pick.title = 'Search work items';
      pick.placeholder = 'Type an ID or words from the title';
      pick.matchOnDescription = true;
      let timer: NodeJS.Timeout | undefined;
      let generation = 0;
      pick.onDidChangeValue(value => {
        clearTimeout(timer);
        const text = value.trim().replace(/^#/, '');
        if (text.length < 2 && !/^\d+$/.test(text)) {
          pick.items = [];
          return;
        }
        const current = ++generation;
        timer = setTimeout(async () => {
          pick.busy = true;
          try {
            const condition = /^\d+$/.test(text)
              ? `[System.Id] = ${text}`
              : text
                  .split(/\s+/)
                  .map(word => `[System.Title] CONTAINS ${wiqlString(word)}`)
                  .join(' AND ');
            const wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND ${condition} ORDER BY [System.ChangedDate] DESC`;
            const ids = await api.workItems.queryIds(project, wiql, 50);
            const items = await api.workItems.getWorkItems(ids);
            if (current === generation) {
              pick.items = items.map(i => {
                const s = summarizeWorkItem(i);
                return { label: s.title, description: `${s.type} ${s.id} · ${s.state}`, detail: s.assignedTo || 'Unassigned', iconPath: workItemTypeIcon(s.type), id: s.id, alwaysShow: true };
              });
            }
          } catch (error) {
            pick.items = [{ label: `$(error) ${error instanceof Error ? error.message : String(error)}`, id: 0, alwaysShow: true }];
          } finally {
            if (current === generation) {
              pick.busy = false;
            }
          }
        }, 350);
      });
      pick.onDidAccept(() => {
        const id = pick.selectedItems[0]?.id;
        pick.hide();
        if (id) {
          WorkItemPanel.show(services, id);
        }
      });
      pick.onDidHide(() => pick.dispose());
      pick.show();
    }),
    registerCommand(services, 'azureDevOps.workItems.create', 'create the work item', () => create()),
    registerCommand(services, 'azureDevOps.workItems.createChild', 'create the child work item', async (arg: WorkItemArg) => {
      const parentId = await resolveId(arg, 'Parent work item');
      if (parentId) {
        await create({ parentId });
      }
    }),
    registerCommand(services, 'azureDevOps.workItems.createFromSelection', 'create the work item', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return create();
      }
      const text = editor.document.getText(editor.selection);
      const relative = vscode.workspace.asRelativePath(editor.document.uri);
      const start = editor.selection.start.line + 1;
      const end = editor.selection.end.line + 1;
      const location = `${relative}:${start}${end !== start ? `-${end}` : ''}`;
      const description = `<p>From <code>${escapeHtml(location)}</code></p>${text ? `<pre><code>${escapeHtml(text)}</code></pre>` : ''}`;
      const firstLine = text.split('\n').find(l => l.trim())?.trim().replace(/^(\/\/|#|\/\*+|\*)\s*/, '').replace(/^(TODO|FIXME|BUG|HACK)[:\s]*/i, '');
      await create({ description, title: firstLine?.slice(0, 120) || `Follow up in ${path.basename(relative)}` });
    }),
    registerCommand(services, 'azureDevOps.workItems.openInBrowser', 'open the work item', async (arg: WorkItemArg) => {
      const id = await resolveId(arg, 'Open work item in browser');
      if (!id) {
        return;
      }
      const { api } = connections.require();
      const project = arg instanceof WorkItemNode ? arg.item.project : String((await api.workItems.getWorkItem(id)).fields['System.TeamProject']);
      await vscode.env.openExternal(vscode.Uri.parse(api.workItems.webUrl(project, id)));
    }),
    registerCommand(services, 'azureDevOps.workItems.copyLink', 'copy the link', async (arg: WorkItemArg) => {
      const id = await resolveId(arg, 'Copy work item link');
      if (!id) {
        return;
      }
      const { api } = connections.require();
      const project = arg instanceof WorkItemNode ? arg.item.project : String((await api.workItems.getWorkItem(id)).fields['System.TeamProject']);
      await vscode.env.clipboard.writeText(api.workItems.webUrl(project, id));
      vscode.window.setStatusBarMessage(`$(check) Copied link to work item ${id}`, 3000);
    }),
    registerCommand(services, 'azureDevOps.workItems.copyAsMarkdown', 'copy the work item', async (arg: WorkItemArg) => {
      const id = await resolveId(arg, 'Copy work item as Markdown');
      if (!id) {
        return;
      }
      const { api } = connections.require();
      const item = await api.workItems.getWorkItem(id);
      const project = String(item.fields['System.TeamProject']);
      const comments = await api.workItems.getComments(project, id).catch(() => []);
      const markdown = workItemMarkdown(
        item,
        api.workItems.webUrl(project, id),
        comments.slice(0, 5).map(c => ({ author: c.createdBy.displayName, text: htmlToText(c.text) })),
      );
      await vscode.env.clipboard.writeText(markdown);
      void vscode.window.showInformationMessage(`Copied work item ${id} as Markdown — paste it into Cursor chat for context.`);
    }),
    registerCommand(services, 'azureDevOps.workItems.changeState', 'change the state', async (arg: WorkItemArg) => {
      const id = await resolveId(arg, 'Change state');
      if (!id || !(await access.ensure('vso.work_write', 'change work item state'))) {
        return;
      }
      const { api } = connections.require();
      const item = await api.workItems.getWorkItem(id);
      const project = String(item.fields['System.TeamProject']);
      const type = String(item.fields['System.WorkItemType']);
      const states = await api.workItems.getTypeStates(project, type);
      const currentState = String(item.fields['System.State']);
      const pick = await vscode.window.showQuickPick(
        states.map(s => ({ label: s.name, description: s.name === currentState ? '(current)' : s.category })),
        { title: `${type} ${id}: change state`, placeHolder: `Currently ${currentState}` },
      );
      if (pick && pick.label !== currentState) {
        await update(id, [
          { op: 'test', path: '/rev', value: item.rev },
          { op: 'add', path: '/fields/System.State', value: pick.label },
        ]);
        vscode.window.setStatusBarMessage(`$(check) ${type} ${id} → ${pick.label}`, 4000);
      }
    }),
    registerCommand(services, 'azureDevOps.workItems.assignToMe', 'assign the work item', async (arg: WorkItemArg) => {
      const id = await resolveId(arg, 'Assign to me');
      if (!id || !(await access.ensure('vso.work_write', 'assign work items'))) {
        return;
      }
      const user = connections.require().user;
      await update(id, [{ op: 'add', path: '/fields/System.AssignedTo', value: user.email ?? user.displayName }]);
      vscode.window.setStatusBarMessage(`$(check) Work item ${id} assigned to you`, 4000);
    }),
    registerCommand(services, 'azureDevOps.workItems.assign', 'assign the work item', async (arg: WorkItemArg) => {
      const id = await resolveId(arg, 'Assign work item');
      if (!id || !(await access.ensure('vso.work_write', 'assign work items'))) {
        return;
      }
      const person = await pickPerson(services, `Assign work item ${id} to…`);
      if (person !== undefined) {
        await update(id, [{ op: 'add', path: '/fields/System.AssignedTo', value: person }]);
      }
    }),
    registerCommand(services, 'azureDevOps.workItems.addComment', 'add the comment', async (arg: WorkItemArg) => {
      const id = await resolveId(arg, 'Comment on work item');
      if (!id || !(await access.ensure('vso.work_write', 'comment on work items'))) {
        return;
      }
      const text = await vscode.window.showInputBox({ title: `Comment on work item ${id}`, prompt: 'Comment' });
      if (!text?.trim()) {
        return;
      }
      const { api } = connections.require();
      const project = arg instanceof WorkItemNode ? arg.item.project : String((await api.workItems.getWorkItem(id)).fields['System.TeamProject']);
      await api.workItems.addComment(project, id, `<p>${escapeHtml(text)}</p>`);
      WorkItemPanel.refreshIfOpen(id);
      vscode.window.setStatusBarMessage(`$(check) Comment added to ${id}`, 3000);
    }),
    registerCommand(services, 'azureDevOps.workItems.createBranch', 'create the branch', async (arg: WorkItemArg) => {
      const id = await resolveId(arg, 'Create branch for work item');
      if (!id) {
        return;
      }
      const { api, organization } = connections.require();
      const item = await api.workItems.getWorkItem(id);
      const template = vscode.workspace.getConfiguration('azureDevOps.workItems').get<string>('branchNameTemplate', 'feature/${id}-${title}');
      const suggested = branchNameFor(template, id, String(item.fields['System.Title'] ?? ''), String(item.fields['System.WorkItemType'] ?? ''));
      const remote = await services.git.findActiveRemote(organization);
      const repository = remote?.repository ?? (vscode.window.activeTextEditor ? await services.git.repositoryFor(vscode.window.activeTextEditor.document.uri) : undefined);
      if (!repository) {
        void vscode.window.showWarningMessage('Open a git repository in the workspace to create a branch.');
        return;
      }
      const name = await vscode.window.showInputBox({
        title: `Create branch for work item ${id}`,
        prompt: 'Branch name (created from the current HEAD and checked out)',
        value: suggested,
        validateInput: v => (/^[^\s~^:?*[\\]+$/.test(v.trim()) && !v.includes('..') ? undefined : 'Not a valid branch name'),
      });
      if (!name) {
        return;
      }
      await repository.createBranch(name.trim(), true);
      void vscode.window.showInformationMessage(
        `Created and checked out ${name.trim()}. Pull requests from this branch will link work item ${id} automatically.`,
      );
    }),
  ];
}
