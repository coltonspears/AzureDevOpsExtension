import * as vscode from 'vscode';
import { AzureDevOpsError } from '../api/errors';
import { WorkItem, WorkItemField } from '../api/types';
import { organizationKey } from '../api/urls';
import { Services } from '../services';
import { WorkItemToHost, WorkItemToWebview, WorkItemViewState } from '../shared/messages';
import { identityName, textToHtml } from '../util/format';
import { reportError } from '../util/reportError';
import { pickPerson } from '../commands/people';
import { summarizeWorkItem } from '../views/workItemsTree';
import { WebviewPanelBase } from './panelBase';
import { RELATION_TYPES, buildFieldModels, buildPatch, describeRelations } from './workItemFields';

/** Rich view/editor for a single work item. */
export class WorkItemPanel extends WebviewPanelBase<WorkItemToHost, WorkItemToWebview> {
  private static readonly panels = new Map<string, WorkItemPanel>();
  private static readonly changedEmitter = new vscode.EventEmitter<number>();
  /** Fires with a work item id after it was changed from a panel. */
  static readonly onDidChangeWorkItem = WorkItemPanel.changedEmitter.event;

  private item?: WorkItem;
  private definitions = new Map<string, WorkItemField>();
  private state: WorkItemViewState = { loading: true, canEdit: 'unknown', saving: false, comments: [] };

  static show(services: Services, id: number): void {
    const connection = services.connections.require();
    const key = `${organizationKey(connection.organization)}:${id}`;
    const existing = WorkItemPanel.panels.get(key);
    if (existing && !existing.disposed) {
      existing.reveal();
      void existing.load();
      return;
    }
    const panel = new WorkItemPanel(services, id);
    WorkItemPanel.panels.set(key, panel);
    panel.onDidDispose(() => WorkItemPanel.panels.delete(key));
  }

  /** Reloads any open panel showing the work item. */
  static refreshIfOpen(id: number): void {
    for (const panel of WorkItemPanel.panels.values()) {
      if (panel.id === id && !panel.disposed) {
        void panel.load();
      }
    }
  }

  private constructor(
    services: Services,
    readonly id: number,
  ) {
    super(services, 'azureDevOps.workItem', `Work Item ${id}`, 'workItem');
    this.track(services.access.onDidChange(() => this.pushAccess()));
  }

  protected async onReady(): Promise<void> {
    await this.load();
  }

  async load(): Promise<void> {
    const { api } = this.services.connections.require();
    this.state = { ...this.state, loading: !this.item, error: undefined };
    this.push();
    try {
      const item = await api.workItems.getWorkItem(this.id);
      const project = String(item.fields['System.TeamProject']);
      const type = String(item.fields['System.WorkItemType']);
      const [types, states, typeFields, definitions, paths, comments] = await Promise.all([
        api.workItems.getTypes(project).catch(() => []),
        api.workItems.getTypeStates(project, type).catch(() => []),
        api.workItems.getTypeFields(project, type).catch(() => []),
        api.workItems.getFieldDefinitions().catch(() => new Map<string, WorkItemField>()),
        api.workItems.getClassificationPaths(project).catch(() => ({ areas: [], iterations: [] })),
        api.workItems.getComments(project, this.id).then(
          c => ({ comments: c }),
          error => ({ comments: [], error: error instanceof Error ? error.message : String(error) }),
        ),
      ]);
      this.item = item;
      this.definitions = definitions;
      const { fields, rich } = buildFieldModels(item, {
        typeFields,
        definitions,
        states,
        areas: paths.areas,
        iterations: paths.iterations,
      });
      const relations = describeRelations(item.relations);
      const linkedIds = relations.map(r => r.workItemId).filter((id): id is number => id !== undefined);
      if (linkedIds.length) {
        const linked = await api.workItems.getWorkItems(linkedIds).catch(() => []);
        const byId = new Map(linked.map(w => [w.id, summarizeWorkItem(w)]));
        for (const relation of relations) {
          const summary = relation.workItemId ? byId.get(relation.workItemId) : undefined;
          if (summary) {
            relation.title = summary.title;
            relation.state = summary.state;
            relation.type = summary.type;
          }
        }
      }
      const typeInfo = types.find(t => t.name === type);
      const stateName = String(item.fields['System.State'] ?? '');
      const stateColor = states.find(s => s.name === stateName)?.color;
      const title = String(item.fields['System.Title'] ?? '');
      this.setTitle(`${type} ${item.id}: ${title.length > 40 ? `${title.slice(0, 40)}…` : title}`);
      this.state = {
        loading: false,
        saving: false,
        canEdit: this.services.access.get('vso.work_write'),
        item: {
          id: item.id,
          rev: item.rev,
          type,
          typeColor: typeInfo?.color ? `#${typeInfo.color}` : undefined,
          title,
          state: stateName,
          stateColor: stateColor ? `#${stateColor}` : undefined,
          reason: item.fields['System.Reason'] as string | undefined,
          project,
          webUrl: item._links?.html?.href ?? api.workItems.webUrl(project, item.id),
          createdBy: identityName(item.fields['System.CreatedBy']),
          createdDate: String(item.fields['System.CreatedDate'] ?? ''),
          changedBy: identityName(item.fields['System.ChangedBy']),
          changedDate: String(item.fields['System.ChangedDate'] ?? ''),
          fields,
          richFields: rich,
          relations,
        },
        comments: comments.comments.map(c => ({
          id: c.id,
          author: c.createdBy.displayName,
          date: c.createdDate,
          html: c.text,
        })),
        commentsError: 'error' in comments ? comments.error : undefined,
      };
    } catch (error) {
      this.state = { ...this.state, loading: false, error: error instanceof Error ? error.message : String(error) };
    }
    this.push();
  }

  protected async onMessage(message: WorkItemToHost): Promise<void> {
    const item = this.item;
    switch (message.type) {
      case 'refresh':
        await this.load();
        return;
      case 'save':
        if (item) {
          await this.save(item, message.changes);
        }
        return;
      case 'addComment':
        await this.addComment(message.text);
        return;
      case 'pickIdentity': {
        const person = await pickPerson(this.services, 'Assign to');
        if (person !== undefined) {
          this.post({ type: 'identityPicked', field: message.field, value: person });
        }
        return;
      }
      case 'openWorkItem':
        WorkItemPanel.show(this.services, message.id);
        return;
      case 'openPullRequest':
        await vscode.commands.executeCommand('azureDevOps.pullRequests.open', message.id);
        return;
      case 'addLink':
        await this.addLink(message.kind);
        return;
      case 'removeLink':
        await this.removeLink(message.index);
        return;
      case 'createChild':
        await vscode.commands.executeCommand('azureDevOps.workItems.createChild', this.id);
        return;
      case 'createBranch':
        await vscode.commands.executeCommand('azureDevOps.workItems.createBranch', this.id);
        return;
      case 'copyLink':
        await vscode.commands.executeCommand('azureDevOps.workItems.copyLink', this.id);
        return;
      case 'copyMarkdown':
        await vscode.commands.executeCommand('azureDevOps.workItems.copyAsMarkdown', this.id);
        return;
      case 'openInBrowser':
        if (this.state.item) {
          await vscode.env.openExternal(vscode.Uri.parse(this.state.item.webUrl));
        }
        return;
    }
  }

  private async save(item: WorkItem, changes: Record<string, string>): Promise<void> {
    if (!Object.keys(changes).length || !(await this.services.access.ensure('vso.work_write', 'edit work items'))) {
      return;
    }
    this.state = { ...this.state, saving: true };
    this.push();
    try {
      const { api } = this.services.connections.require();
      await api.workItems.updateWorkItem(item.id, buildPatch(item, changes, this.definitions));
      this.post({ type: 'saved' });
      this.post({ type: 'toast', kind: 'info', message: 'Work item saved' });
      WorkItemPanel.changedEmitter.fire(item.id);
      await this.load();
    } catch (error) {
      this.state = { ...this.state, saving: false };
      this.push();
      if (error instanceof AzureDevOpsError && (error.status === 409 || error.status === 412 || /TF26071|test operation/i.test(error.message))) {
        const reload = 'Reload';
        const choice = await vscode.window.showWarningMessage(
          `Work item ${item.id} was changed by someone else since it was opened. Reload to see their changes (your unsaved edits will be lost).`,
          reload,
        );
        if (choice === reload) {
          await this.load();
        }
        return;
      }
      await reportError(error, 'save the work item', this.services.access);
    }
  }

  private async addComment(text: string): Promise<void> {
    if (!text.trim() || !this.state.item || !(await this.services.access.ensure('vso.work_write', 'comment on work items'))) {
      return;
    }
    const project = this.state.item.project;
    await this.run('Add comment', async () => {
      const { api } = this.services.connections.require();
      await api.workItems.addComment(project, this.id, textToHtml(text));
      this.post({ type: 'saved' });
      await this.load();
    });
  }

  private async addLink(kind: 'parent' | 'child' | 'related'): Promise<void> {
    if (!this.item || !(await this.services.access.ensure('vso.work_write', 'link work items'))) {
      return;
    }
    const input = await vscode.window.showInputBox({
      title: `Add ${kind} link to work item ${this.id}`,
      prompt: `ID of the ${kind} work item`,
      validateInput: value => (/^\d+$/.test(value.trim()) ? undefined : 'Enter a numeric work item ID'),
    });
    if (!input) {
      return;
    }
    const target = Number(input.trim());
    const item = this.item;
    await this.run('Add link', async () => {
      const { api } = this.services.connections.require();
      await api.workItems.updateWorkItem(item.id, [
        { op: 'test', path: '/rev', value: item.rev },
        { op: 'add', path: '/relations/-', value: { rel: RELATION_TYPES[kind], url: api.workItems.apiUrl(target) } },
      ]);
      WorkItemPanel.changedEmitter.fire(item.id);
      await this.load();
    });
  }

  private async removeLink(index: number): Promise<void> {
    if (!this.item || !(await this.services.access.ensure('vso.work_write', 'remove links'))) {
      return;
    }
    const confirm = await vscode.window.showWarningMessage('Remove this link?', { modal: true }, 'Remove');
    if (confirm !== 'Remove') {
      return;
    }
    const item = this.item;
    await this.run('Remove link', async () => {
      const { api } = this.services.connections.require();
      await api.workItems.updateWorkItem(item.id, [
        { op: 'test', path: '/rev', value: item.rev },
        { op: 'remove', path: `/relations/${index}` },
      ]);
      WorkItemPanel.changedEmitter.fire(item.id);
      await this.load();
    });
  }

  private pushAccess(): void {
    const canEdit = this.services.access.get('vso.work_write');
    if (canEdit !== this.state.canEdit) {
      this.state = { ...this.state, canEdit };
      this.push();
    }
  }

  private push(): void {
    const org = this.services.connections.connection?.organization;
    this.post({ type: 'state', state: { ...this.state, organization: org ? { url: org.url, name: org.name } : undefined } });
  }
}
