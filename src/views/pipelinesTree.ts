import * as vscode from 'vscode';
import { Build, BuildDefinitionReference, PipelineApproval, Release, ReleaseDefinition } from '../api/types';
import { shortRefName } from '../api/git';
import { Services } from '../services';
import { duration, pluralize, relativeTime } from '../util/format';
import { buildIcon, buildStatusText, timelineIcon } from './icons';
import { TimelineTreeNode, buildTimelineTree, timelineIsActive } from './timeline';
import { GroupNode, MessageNode, NodeTreeProvider, TreeNode, lockedNode } from './treeNodes';

export class RunNode extends TreeNode {
  constructor(
    readonly build: Build,
    readonly project: string,
    private readonly tree: PipelinesTree,
    private readonly parentId: string,
    private readonly showDefinition: boolean,
  ) {
    super();
  }

  getTreeItem(): vscode.TreeItem {
    const b = this.build;
    const label = this.showDefinition ? `${b.definition.name} #${b.buildNumber}` : `#${b.buildNumber}`;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `${this.parentId}/run:${b.id}`;
    const when = b.status === 'completed' ? relativeTime(b.finishTime) : buildStatusText(b);
    item.description = [shortRefName(b.sourceBranch), when].filter(Boolean).join(' · ');
    item.iconPath = buildIcon(b);
    item.contextValue = `pipelineRun:${b.status}:${b.result ?? 'none'}`;
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${b.definition.name} #${b.buildNumber}** — ${buildStatusText(b)}\n\n`);
    tooltip.appendMarkdown(`Branch: \`${shortRefName(b.sourceBranch)}\`${b.sourceVersion ? ` @ \`${b.sourceVersion.slice(0, 8)}\`` : ''}\n\n`);
    if (b.requestedFor) {
      tooltip.appendMarkdown(`Requested for ${b.requestedFor.displayName}${b.reason ? ` (${b.reason})` : ''}\n\n`);
    }
    if (b.startTime) {
      tooltip.appendMarkdown(`Started ${relativeTime(b.startTime)} · Duration ${duration(b.startTime, b.finishTime)}`);
    }
    item.tooltip = tooltip;
    return item;
  }

  override async getChildren(): Promise<TreeNode[]> {
    const { api } = this.services();
    const timeline = await api.builds.getTimeline(this.project, this.build.id);
    if (!timeline?.records.length) {
      return [new MessageNode(this.build.status === 'notStarted' ? 'Waiting for an agent…' : 'No timeline yet', 'info')];
    }
    if (timelineIsActive(timeline.records)) {
      this.tree.noteActivity();
    }
    return buildTimelineTree(timeline.records).map(
      n => new TimelineNode(n, this.build, this.project, `${this.parentId}/run:${this.build.id}`),
    );
  }

  private services() {
    return this.tree.services.connections.require();
  }
}

export class TimelineNode extends TreeNode {
  constructor(
    readonly node: TimelineTreeNode,
    readonly build: Build,
    readonly project: string,
    private readonly parentId: string,
  ) {
    super();
  }

  getTreeItem(): vscode.TreeItem {
    const r = this.node.record;
    const item = new vscode.TreeItem(
      r.name,
      this.node.children.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    item.id = `${this.parentId}/rec:${r.id}`;
    item.iconPath = timelineIcon(r);
    const counts = [r.errorCount ? pluralize(r.errorCount, 'error') : '', r.warningCount ? pluralize(r.warningCount, 'warning') : '']
      .filter(Boolean)
      .join(', ');
    const time = r.state === 'pending' ? 'pending' : duration(r.startTime, r.finishTime);
    item.description = [time, counts].filter(Boolean).join(' · ');
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${r.type}: ${r.name}** — ${r.result ?? r.state ?? ''}\n\n`);
    for (const issue of (r.issues ?? []).slice(0, 10)) {
      tooltip.appendMarkdown(`${issue.type === 'error' ? '$(error)' : '$(warning)'} ${issue.message.replace(/[\\`*_[\]<>]/g, '\\$&')}\n\n`);
    }
    tooltip.supportThemeIcons = true;
    item.tooltip = tooltip;
    item.contextValue = r.log ? 'timelineRecord:log' : 'timelineRecord';
    if (r.log) {
      item.command = {
        command: 'azureDevOps.pipelines.openLog',
        title: 'Open Log',
        arguments: [
          {
            project: this.project,
            buildId: this.build.id,
            logId: r.log.id,
            recordId: r.id,
            title: `${this.build.definition.name} #${this.build.buildNumber} — ${r.name}`,
          },
        ],
      };
    }
    return item;
  }

  override getChildren(): TreeNode[] {
    return this.node.children.map(child => new TimelineNode(child, this.build, this.project, `${this.parentId}/rec:${this.node.record.id}`));
  }
}

export class DefinitionNode extends TreeNode {
  constructor(
    readonly definition: BuildDefinitionReference,
    readonly project: string,
    private readonly tree: PipelinesTree,
  ) {
    super();
  }

  getTreeItem(): vscode.TreeItem {
    const d = this.definition;
    const item = new vscode.TreeItem(d.name, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `def:${d.id}`;
    const latest = d.latestBuild;
    item.iconPath = latest ? buildIcon(latest) : new vscode.ThemeIcon('circle-outline');
    item.description = latest
      ? `${buildStatusText(latest)} · ${relativeTime(latest.finishTime ?? latest.queueTime)}`
      : 'No runs yet';
    item.tooltip = `${d.path === '\\' ? '' : `${d.path}\\`}${d.name}${d.queueStatus === 'disabled' ? ' (disabled)' : ''}`;
    item.contextValue = 'pipelineDefinition';
    return item;
  }

  override async getChildren(): Promise<TreeNode[]> {
    const { api } = this.tree.services.connections.require();
    const builds = await api.builds.listBuilds(this.project, { definitionId: this.definition.id, top: 10 });
    this.tree.noteBuilds(builds);
    if (!builds.length) {
      return [new MessageNode('No runs yet', 'info')];
    }
    return builds.map(b => new RunNode(b, this.project, this.tree, `def:${this.definition.id}`, false));
  }
}

export class ApprovalNode extends TreeNode {
  constructor(
    readonly approval: PipelineApproval,
    readonly project: string,
  ) {
    super();
  }

  getTreeItem(): vscode.TreeItem {
    const a = this.approval;
    const pipeline = a.pipeline?.name ?? 'Pipeline';
    const run = a.pipeline?.owner?.name ? ` #${a.pipeline.owner.name}` : '';
    const item = new vscode.TreeItem(`${pipeline}${run}`);
    item.id = `approval:${a.id}`;
    item.iconPath = new vscode.ThemeIcon('person', new vscode.ThemeColor('list.warningForeground'));
    item.description = `waiting for approval · ${relativeTime(a.createdOn)}`;
    const approvers = (a.steps ?? []).map(s => s.assignedApprover.displayName).join(', ');
    item.tooltip = `${a.instructions ? `${a.instructions}\n\n` : ''}Approvers: ${approvers || 'unknown'}`;
    item.contextValue = 'pipelineApproval';
    return item;
  }
}

class ReleaseDefinitionNode extends TreeNode {
  constructor(
    private readonly definition: ReleaseDefinition,
    private readonly project: string,
    private readonly services: Services,
  ) {
    super();
  }

  getTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(this.definition.name, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `reldef:${this.definition.id}`;
    item.iconPath = new vscode.ThemeIcon('rocket');
    item.contextValue = 'releaseDefinition';
    return item;
  }

  override async getChildren(): Promise<TreeNode[]> {
    const { api } = this.services.connections.require();
    const releases = await api.releases.listReleases(this.project, this.definition.id);
    if (!releases.length) {
      return [new MessageNode('No releases', 'info')];
    }
    return releases.map(r => new ReleaseNode(r, this.project));
  }
}

const ENVIRONMENT_ICONS: Record<string, string> = {
  succeeded: '$(pass)',
  partiallySucceeded: '$(warning)',
  rejected: '$(error)',
  canceled: '$(circle-slash)',
  inProgress: '$(sync)',
  queued: '$(clock)',
  scheduled: '$(clock)',
  notStarted: '$(circle-outline)',
};

export class ReleaseNode extends TreeNode {
  constructor(
    readonly release: Release,
    readonly project: string,
  ) {
    super();
  }

  getTreeItem(): vscode.TreeItem {
    const r = this.release;
    const item = new vscode.TreeItem(r.name);
    item.id = `release:${r.id}`;
    const envs = r.environments ?? [];
    const failed = envs.some(e => e.status === 'rejected');
    const running = envs.some(e => e.status === 'inProgress');
    item.iconPath = running
      ? new vscode.ThemeIcon('sync~spin')
      : failed
        ? new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'))
        : envs.length && envs.every(e => e.status === 'succeeded')
          ? new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'))
          : new vscode.ThemeIcon('circle-outline');
    item.description = `${relativeTime(r.createdOn)} · ${envs.map(e => e.name).join(' → ')}`;
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown(`**${r.name}** (${r.releaseDefinition.name})\n\n`);
    for (const env of envs) {
      tooltip.appendMarkdown(`${ENVIRONMENT_ICONS[env.status] ?? '$(circle-outline)'} ${env.name}: ${env.status}\n\n`);
    }
    item.tooltip = tooltip;
    item.contextValue = 'release';
    return item;
  }
}

export class PipelinesTree implements vscode.Disposable {
  readonly provider: NodeTreeProvider;
  private readonly disposables: vscode.Disposable[] = [];
  private view?: vscode.TreeView<TreeNode>;
  private refreshTimer?: NodeJS.Timeout;
  private active = false;

  constructor(readonly services: Services) {
    this.provider = new NodeTreeProvider(() => this.roots(), 'Pipelines');
    let lastDenied = services.access.isDenied('vso.build');
    this.disposables.push(
      this.provider,
      services.connections.onDidChange(() => this.refresh()),
      services.access.onDidChange(() => {
        const denied = services.access.isDenied('vso.build');
        if (denied !== lastDenied) {
          lastDenied = denied;
          this.refresh();
        }
      }),
    );
  }

  setView(view: vscode.TreeView<TreeNode>): void {
    this.view = view;
    this.disposables.push(
      view.onDidChangeVisibility(e => {
        if (e.visible && this.active) {
          this.scheduleRefresh();
        }
      }),
    );
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    this.disposables.forEach(d => d.dispose());
  }

  refresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.active = false;
    this.provider.refresh();
  }

  noteBuilds(builds: Build[]): void {
    if (builds.some(b => b.status !== 'completed')) {
      this.noteActivity();
    }
  }

  /** Something visible is still running; poll so statuses and logs stay live. */
  noteActivity(): void {
    this.active = true;
    this.scheduleRefresh();
  }

  private scheduleRefresh(): void {
    const seconds = vscode.workspace.getConfiguration('azureDevOps.pipelines').get<number>('refreshIntervalSeconds', 15);
    if (seconds <= 0 || this.refreshTimer || (this.view && !this.view.visible)) {
      return;
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      if (!this.view || this.view.visible) {
        this.refresh();
      }
    }, Math.max(5, seconds) * 1000);
  }

  private async roots(): Promise<TreeNode[]> {
    const { connections, access } = this.services;
    if (!connections.isSignedIn || !connections.project || access.isDenied('vso.build')) {
      return [];
    }
    const { api, project, user } = connections.requireProject();
    const nodes: TreeNode[] = [];

    const approvals = await api.builds.listPendingApprovals(project).catch(() => [] as PipelineApproval[]);
    const mine = approvals.filter(a => (a.steps ?? []).some(s => s.assignedApprover.id === user.id && s.status === 'pending'));
    if (approvals.length) {
      nodes.push(
        new GroupNode('pl:approvals', 'Pending Approvals', async () => approvals.map(a => new ApprovalNode(a, project)), {
          icon: 'bell-dot',
          expanded: true,
          description: mine.length ? `${mine.length} waiting on you` : `${approvals.length}`,
        }),
      );
    }

    const runs = (key: string, label: string, icon: string, load: () => Promise<Build[]>, expanded = false) =>
      new GroupNode(
        `pl:${key}`,
        label,
        async () => {
          const builds = await load();
          this.noteBuilds(builds);
          return builds.map(b => new RunNode(b, project, this, `pl:${key}`, true));
        },
        { icon, expanded, what: label, emptyMessage: 'No runs' },
      );

    nodes.push(
      runs('recent', 'Recent Runs', 'history', () => api.builds.listBuilds(project, { top: 15 }), true),
      runs('mine', 'My Runs', 'account', () => api.builds.listBuilds(project, { requestedFor: user.id, top: 15 })),
      new GroupNode('pl:all', 'All Pipelines', () => this.definitionFolders(), {
        icon: 'rocket',
        what: 'Pipelines',
        emptyMessage: 'No pipelines in this project',
      }),
    );

    if (access.isDenied('vso.release')) {
      nodes.push(lockedNode('vso.release', 'Classic releases'));
    } else {
      nodes.push(
        new GroupNode(
          'pl:releases',
          'Classic Releases',
          async () => (await api.releases.listDefinitions(project)).map(d => new ReleaseDefinitionNode(d, project, this.services)),
          { icon: 'package', what: 'Classic releases', emptyMessage: 'No classic release pipelines' },
        ),
      );
    }
    return nodes;
  }

  private async definitionFolders(): Promise<TreeNode[]> {
    const { api, project } = this.services.connections.requireProject();
    const definitions = await api.builds.listDefinitions(project);
    return this.folderChildren('\\', definitions, project);
  }

  private folderChildren(folder: string, definitions: BuildDefinitionReference[], project: string): TreeNode[] {
    const normalize = (p: string) => (p.endsWith('\\') ? p : `${p}\\`);
    const prefix = normalize(folder);
    const subfolders = new Set<string>();
    const here: BuildDefinitionReference[] = [];
    for (const definition of definitions) {
      const path = normalize(definition.path || '\\');
      if (path === prefix) {
        here.push(definition);
      } else if (path.toLowerCase().startsWith(prefix.toLowerCase())) {
        subfolders.add(path.slice(prefix.length).split('\\')[0]);
      }
    }
    const folders = [...subfolders].sort((a, b) => a.localeCompare(b)).map(
      name =>
        new GroupNode(`plf:${prefix}${name}`, name, async () => this.folderChildren(`${prefix}${name}`, definitions, project), {
          icon: 'folder',
        }),
    );
    return [...folders, ...here.sort((a, b) => a.name.localeCompare(b.name)).map(d => new DefinitionNode(d, project, this))];
  }
}
