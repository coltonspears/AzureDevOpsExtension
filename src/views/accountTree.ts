import * as vscode from 'vscode';
import { displayOrganizationUrl } from '../api/urls';
import { FEATURES, FeatureDefinition, scopeLabel, summarizeFeatures } from '../auth/scopes';
import { Services } from '../services';
import { relativeTime } from '../util/format';
import { MessageNode, NodeTreeProvider, TreeNode } from './treeNodes';

class FeatureNode extends TreeNode {
  constructor(
    private readonly services: Services,
    private readonly feature: FeatureDefinition,
  ) {
    super();
  }

  getTreeItem(): vscode.TreeItem {
    const state = this.services.access.feature(this.feature.id);
    const item = new vscode.TreeItem(this.feature.label);
    item.id = `feature:${this.feature.id}`;
    const scopes = this.feature.requires.map(scopeLabel).join(', ');
    if (state === 'granted') {
      item.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
      item.description = scopes;
    } else if (state === 'denied') {
      item.iconPath = new vscode.ThemeIcon('lock', new vscode.ThemeColor('list.warningForeground'));
      item.description = `needs ${scopes}`;
    } else {
      item.iconPath = new vscode.ThemeIcon('question', new vscode.ThemeColor('disabledForeground'));
      item.description = `${scopes} · not verified`;
    }
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown(`**${this.feature.label}** — ${state === 'granted' ? 'available' : state === 'denied' ? 'locked' : 'not verified'}\n\n`);
    tooltip.appendMarkdown(`${this.feature.description}\n\n`);
    tooltip.appendMarkdown(`Requires PAT scope: **${scopes}**`);
    item.tooltip = tooltip;
    item.contextValue = `feature:${state}`;
    item.command = { command: 'azureDevOps.explainFeature', title: 'Explain', arguments: [this.feature.id] };
    return item;
  }
}

class AccessNode extends TreeNode {
  constructor(private readonly services: Services) {
    super();
  }

  getTreeItem(): vscode.TreeItem {
    const { access } = this.services;
    const summary = summarizeFeatures(access.states());
    const item = new vscode.TreeItem('PAT Access', vscode.TreeItemCollapsibleState.Expanded);
    item.id = 'access';
    if (access.checking) {
      item.iconPath = new vscode.ThemeIcon('loading~spin');
      item.description = 'Checking scopes…';
    } else if (summary.fullAccess) {
      item.iconPath = new vscode.ThemeIcon('shield', new vscode.ThemeColor('testing.iconPassed'));
      item.description = 'All features available';
    } else if (summary.denied) {
      item.iconPath = new vscode.ThemeIcon('shield', new vscode.ThemeColor('list.warningForeground'));
      item.description = `${summary.granted}/${summary.total} available · ${summary.denied} locked`;
    } else {
      item.iconPath = new vscode.ThemeIcon('shield');
      item.description = `${summary.granted}/${summary.total} available`;
    }
    item.tooltip = access.checkedAt
      ? `Scopes last checked ${relativeTime(new Date(access.checkedAt).toISOString())}. Click to see every scope.`
      : 'Scopes have not been checked yet.';
    item.contextValue = 'access';
    item.command = { command: 'azureDevOps.showAccess', title: 'Show Access' };
    return item;
  }

  override getChildren(): TreeNode[] {
    return FEATURES.map(f => new FeatureNode(this.services, f));
  }
}

export class AccountTree implements vscode.Disposable {
  readonly provider: NodeTreeProvider;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly services: Services) {
    this.provider = new NodeTreeProvider(() => this.roots(), 'Account');
    this.disposables.push(
      this.provider,
      services.connections.onDidChange(() => this.provider.refresh()),
      services.access.onDidChange(() => this.provider.refresh()),
    );
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }

  private async roots(): Promise<TreeNode[]> {
    const { connections } = this.services;
    const connection = connections.connection;
    if (!connection) {
      return [];
    }
    const org = connection.organization;
    return [
      new MessageNode(
        `${org.name}`,
        'organization',
        { command: 'azureDevOps.switchOrganization', title: 'Switch Organization' },
        `${displayOrganizationUrl(org)}${org.kind === 'server' ? ' (Azure DevOps Server)' : ''}\nClick to switch organization.`,
      ),
      new MessageNode(
        connection.user.email ? `${connection.user.displayName} (${connection.user.email})` : connection.user.displayName,
        'account',
        undefined,
        'Identity of the Personal Access Token',
      ),
      new MessageNode(
        connections.project ? `Project: ${connections.project}` : 'Select a project…',
        'project',
        { command: 'azureDevOps.selectProject', title: 'Select Project' },
        'Click to change the project',
      ),
      new MessageNode(
        `Team: ${connections.team ?? 'Default team'}`,
        'organization',
        { command: 'azureDevOps.selectTeam', title: 'Select Team' },
        'Team used for the current iteration. Click to change.',
      ),
      new AccessNode(this.services),
    ];
  }
}

/** Status bar entry showing the connection and whether any features are locked. */
export class AccountStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('azureDevOps.status', vscode.StatusBarAlignment.Left, 50);
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly services: Services) {
    this.item.name = 'Azure DevOps';
    this.disposables.push(
      this.item,
      services.connections.onDidChange(() => this.update()),
      services.access.onDidChange(() => this.update()),
    );
    this.update();
    this.item.show();
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }

  private update(): void {
    const { connections, access } = this.services;
    const connection = connections.connection;
    if (!connection) {
      this.item.text = '$(azure-devops) Sign in';
      this.item.tooltip = 'Azure DevOps: sign in with a Personal Access Token';
      this.item.command = 'azureDevOps.signIn';
      this.item.backgroundColor = undefined;
      return;
    }
    const summary = summarizeFeatures(access.states());
    const place = connections.project ? `${connection.organization.name}/${connections.project}` : connection.organization.name;
    this.item.text = `$(azure-devops) ${place}${summary.denied ? ` $(lock) ${summary.denied}` : ''}`;
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.isTrusted = { enabledCommands: ['azureDevOps.showAccess', 'azureDevOps.recheckAccess', 'azureDevOps.selectProject'] };
    tooltip.appendMarkdown(`**Azure DevOps** — ${connection.user.displayName}\n\n`);
    tooltip.appendMarkdown(`${displayOrganizationUrl(connection.organization)}${connections.project ? ` · ${connections.project}` : ''}\n\n`);
    for (const feature of FEATURES) {
      const state = access.feature(feature.id);
      const icon = state === 'granted' ? '$(pass)' : state === 'denied' ? '$(lock)' : '$(question)';
      tooltip.appendMarkdown(`${icon} ${feature.label}${state === 'denied' ? ` — needs *${feature.requires.map(scopeLabel).join(', ')}*` : ''}\n\n`);
    }
    tooltip.appendMarkdown('[Show access details](command:azureDevOps.showAccess) · [Re-check](command:azureDevOps.recheckAccess)');
    this.item.tooltip = tooltip;
    this.item.command = 'azureDevOps.showAccess';
  }
}
