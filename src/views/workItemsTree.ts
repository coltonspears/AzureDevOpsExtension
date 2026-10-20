import * as vscode from 'vscode';
import { QueryHierarchyItem, WorkItem } from '../api/types';
import { Services } from '../services';
import { identityName, relativeTime, wiqlString } from '../util/format';
import { workItemTypeIcon } from './icons';
import { GroupNode, MessageNode, NodeTreeProvider, TreeNode } from './treeNodes';

/** Lightweight description of a work item used by tree nodes and commands. */
export interface WorkItemSummary {
  id: number;
  title: string;
  type: string;
  state: string;
  project: string;
  assignedTo: string;
  iterationPath?: string;
  tags?: string;
  changedDate?: string;
  priority?: number;
}

export function summarizeWorkItem(item: WorkItem): WorkItemSummary {
  const f = item.fields;
  return {
    id: item.id,
    title: String(f['System.Title'] ?? ''),
    type: String(f['System.WorkItemType'] ?? ''),
    state: String(f['System.State'] ?? ''),
    project: String(f['System.TeamProject'] ?? ''),
    assignedTo: identityName(f['System.AssignedTo']),
    iterationPath: f['System.IterationPath'] as string | undefined,
    tags: f['System.Tags'] as string | undefined,
    changedDate: f['System.ChangedDate'] as string | undefined,
    priority: f['Microsoft.VSTS.Common.Priority'] as number | undefined,
  };
}

export class WorkItemNode extends TreeNode {
  constructor(
    readonly item: WorkItemSummary,
    private readonly parentId: string,
  ) {
    super();
  }

  getTreeItem(): vscode.TreeItem {
    const { item } = this;
    const tree = new vscode.TreeItem(item.title || `#${item.id}`);
    tree.id = `${this.parentId}/wi:${item.id}`;
    tree.description = `#${item.id} · ${item.state}${item.assignedTo ? ` · ${item.assignedTo}` : ''}`;
    tree.iconPath = workItemTypeIcon(item.type);
    tree.contextValue = 'workItem';
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${item.type} ${item.id}**: ${escapeMarkdown(item.title)}\n\n`);
    tooltip.appendMarkdown(`State: **${item.state}**  \n`);
    tooltip.appendMarkdown(`Assigned to: ${item.assignedTo || '_Unassigned_'}  \n`);
    if (item.iterationPath) {
      tooltip.appendMarkdown(`Iteration: ${escapeMarkdown(item.iterationPath)}  \n`);
    }
    if (item.priority !== undefined) {
      tooltip.appendMarkdown(`Priority: ${item.priority}  \n`);
    }
    if (item.tags) {
      tooltip.appendMarkdown(`Tags: ${escapeMarkdown(item.tags)}  \n`);
    }
    if (item.changedDate) {
      tooltip.appendMarkdown(`Changed ${relativeTime(item.changedDate)}`);
    }
    tree.tooltip = tooltip;
    tree.command = { command: 'azureDevOps.workItems.open', title: 'Open Work Item', arguments: [this] };
    return tree;
  }
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

export class WorkItemsTree implements vscode.Disposable {
  readonly provider: NodeTreeProvider;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly services: Services) {
    this.provider = new NodeTreeProvider(() => this.roots(), 'Work items');
    this.disposables.push(
      this.provider,
      services.connections.onDidChange(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('azureDevOps.workItems')) {
          this.refresh();
        }
      }),
    );
    // Re-render when access to work items is learned or lost.
    let lastDenied = services.access.isDenied('vso.work');
    this.disposables.push(
      services.access.onDidChange(() => {
        const denied = services.access.isDenied('vso.work');
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

  private config() {
    const config = vscode.workspace.getConfiguration('azureDevOps.workItems');
    return {
      hiddenStates: config.get<string[]>('hiddenStates', ['Closed', 'Done', 'Removed', 'Completed', 'Cut']),
      max: Math.min(Math.max(config.get<number>('maxResults', 100), 1), 200),
    };
  }

  private stateFilter(): string {
    const { hiddenStates } = this.config();
    return hiddenStates.length ? ` AND [System.State] NOT IN (${hiddenStates.map(wiqlString).join(', ')})` : '';
  }

  private async roots(): Promise<TreeNode[]> {
    const { connections, access } = this.services;
    if (!connections.isSignedIn || !connections.project || access.isDenied('vso.work')) {
      return []; // welcome view explains what is needed
    }
    const select = 'SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project';
    const order = ' ORDER BY [System.ChangedDate] DESC';
    const filter = this.stateFilter();
    return [
      this.queryGroup('assigned', 'Assigned to Me', 'account', `${select} AND [System.AssignedTo] = @me${filter}${order}`, true),
      new GroupNode('wi:iteration', 'Current Iteration', () => this.currentIteration(), {
        icon: 'calendar',
        what: 'Current iteration',
        emptyMessage: 'No work items in the current iteration',
        tooltip: `Work items in the current iteration of ${connections.team ?? 'the default team'}`,
      }),
      this.queryGroup('created', 'Created by Me', 'edit', `${select} AND [System.CreatedBy] = @me${filter}${order}`),
      this.queryGroup(
        'recent',
        'Recently Changed by Me',
        'history',
        `${select} AND [System.ChangedBy] = @me AND [System.ChangedDate] >= @today - 14${order}`,
      ),
      new GroupNode('wi:queries', 'Saved Queries', () => this.savedQueries(), {
        icon: 'search',
        what: 'Saved queries',
        emptyMessage: 'No saved queries',
      }),
    ];
  }

  private queryGroup(key: string, label: string, icon: string, wiql: string, expanded = false): GroupNode {
    return new GroupNode(`wi:${key}`, label, () => this.runWiql(wiql, `wi:${key}`), {
      icon,
      expanded,
      what: label,
      emptyMessage: 'No work items',
    });
  }

  private async runWiql(wiql: string, parentId: string, team?: string): Promise<TreeNode[]> {
    const { api, project } = this.services.connections.requireProject();
    const ids = await api.workItems.queryIds(project, wiql, this.config().max, team);
    const items = await api.workItems.getWorkItems(ids);
    return items.map(i => new WorkItemNode(summarizeWorkItem(i), parentId));
  }

  private async currentIteration(): Promise<TreeNode[]> {
    const { api, project } = this.services.connections.requireProject();
    const team = this.services.connections.team;
    const iteration = await api.workItems.getCurrentIteration(project, team);
    if (!iteration) {
      return [new MessageNode('The team has no current iteration', 'info')];
    }
    const wiql =
      `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.IterationPath] = ${wiqlString(iteration.path)}` +
      `${this.stateFilter()} ORDER BY [Microsoft.VSTS.Common.Priority] ASC, [System.Id] ASC`;
    const nodes = await this.runWiql(wiql, 'wi:iteration', team);
    const dates =
      iteration.attributes?.startDate && iteration.attributes.finishDate
        ? ` (${new Date(iteration.attributes.startDate).toLocaleDateString()} – ${new Date(iteration.attributes.finishDate).toLocaleDateString()})`
        : '';
    return [new MessageNode(`${iteration.name}${dates}`, 'milestone', undefined, iteration.path), ...nodes];
  }

  private async savedQueries(): Promise<TreeNode[]> {
    const { api, project } = this.services.connections.requireProject();
    const roots = await api.workItems.getQueries(project);
    return roots.map(q => this.queryNode(q));
  }

  private queryNode(query: QueryHierarchyItem): TreeNode {
    if (query.isFolder) {
      return new GroupNode(
        `wiq:${query.id}`,
        query.name,
        async () => {
          let children = query.children;
          if (!children && query.hasChildren) {
            const { api, project } = this.services.connections.requireProject();
            children = (await api.workItems.getQuery(project, query.id)).children;
          }
          return (children ?? []).map(c => this.queryNode(c));
        },
        { icon: query.isPublic ? 'folder-library' : 'folder', emptyMessage: 'Empty folder', what: query.name },
      );
    }
    return new GroupNode(
      `wiq:${query.id}`,
      query.name,
      async () => {
        const { api, project } = this.services.connections.requireProject();
        const ids = await api.workItems.runSavedQuery(project, query.id, this.config().max);
        const items = await api.workItems.getWorkItems(ids);
        return items.map(i => new WorkItemNode(summarizeWorkItem(i), `wiq:${query.id}`));
      },
      {
        icon: query.queryType === 'flat' ? 'list-flat' : 'list-tree',
        tooltip: query.path,
        emptyMessage: 'No results',
        what: query.name,
        contextValue: 'savedQuery',
      },
    );
  }
}
