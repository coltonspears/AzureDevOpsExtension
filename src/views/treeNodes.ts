import * as vscode from 'vscode';
import { AccessDeniedError, AuthenticationError, NoProjectError, NotSignedInError } from '../api/errors';
import { scopeLabel } from '../auth/scopes';
import { errorMessage } from '../util/reportError';

export abstract class TreeNode {
  abstract getTreeItem(): vscode.TreeItem | Promise<vscode.TreeItem>;

  getChildren(): TreeNode[] | Promise<TreeNode[]> {
    return [];
  }
}

/** A leaf showing a short message, optionally clickable. */
export class MessageNode extends TreeNode {
  constructor(
    private readonly label: string,
    private readonly icon?: string,
    private readonly command?: vscode.Command,
    private readonly tooltip?: string,
    private readonly color?: string,
  ) {
    super();
  }

  getTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(this.label, vscode.TreeItemCollapsibleState.None);
    if (this.icon) {
      item.iconPath = new vscode.ThemeIcon(this.icon, this.color ? new vscode.ThemeColor(this.color) : undefined);
    }
    item.command = this.command;
    item.tooltip = this.tooltip;
    item.contextValue = 'message';
    return item;
  }
}

/** Shown in place of content the PAT is not allowed to read. Clicking explains how to fix it. */
export function lockedNode(scope: Parameters<typeof scopeLabel>[0], what: string): TreeNode {
  return new MessageNode(
    `${what} — requires ${scopeLabel(scope)}`,
    'lock',
    { command: 'azureDevOps.explainScope', title: 'Why is this locked?', arguments: [scope, `view ${what.toLowerCase()}`] },
    `Your Personal Access Token does not grant the "${scopeLabel(scope)}" scope. Click to see how to enable it.`,
    'list.warningForeground',
  );
}

/** Converts a load failure into a node that explains what went wrong. */
export function errorNode(error: unknown, what: string): TreeNode {
  if (error instanceof AccessDeniedError && error.scope) {
    return lockedNode(error.scope, what);
  }
  if (error instanceof AccessDeniedError) {
    return new MessageNode(`${what}: access denied`, 'lock', undefined, error.message, 'list.warningForeground');
  }
  if (error instanceof AuthenticationError) {
    return new MessageNode(
      'PAT rejected — click to update it',
      'key',
      { command: 'azureDevOps.updatePat', title: 'Update PAT' },
      error.message,
      'list.errorForeground',
    );
  }
  if (error instanceof NotSignedInError) {
    return new MessageNode('Sign in to Azure DevOps', 'sign-in', { command: 'azureDevOps.signIn', title: 'Sign In' });
  }
  if (error instanceof NoProjectError) {
    return new MessageNode('Select a project', 'project', { command: 'azureDevOps.selectProject', title: 'Select Project' });
  }
  return new MessageNode(
    `Couldn't load ${what.toLowerCase()}: ${errorMessage(error)}`,
    'error',
    undefined,
    errorMessage(error),
    'list.errorForeground',
  );
}

/** Generic provider over TreeNode objects with per-node error handling. */
export class NodeTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly roots: () => Promise<TreeNode[]>,
    private readonly what: string,
  ) {}

  dispose(): void {
    this.emitter.dispose();
  }

  refresh(node?: TreeNode): void {
    this.emitter.fire(node);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem | Promise<vscode.TreeItem> {
    return node.getTreeItem();
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    try {
      return await (node ? node.getChildren() : this.roots());
    } catch (error) {
      return [errorNode(error, this.what)];
    }
  }
}

/** A collapsible group whose children are loaded on expansion. */
export class GroupNode extends TreeNode {
  constructor(
    private readonly id: string,
    private readonly label: string,
    private readonly loader: () => Promise<TreeNode[]>,
    private readonly options: {
      icon?: string;
      expanded?: boolean;
      description?: string;
      tooltip?: string;
      contextValue?: string;
      emptyMessage?: string;
      what?: string;
    } = {},
  ) {
    super();
  }

  getTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(
      this.label,
      this.options.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = this.id;
    item.description = this.options.description;
    item.tooltip = this.options.tooltip;
    item.contextValue = this.options.contextValue ?? 'group';
    if (this.options.icon) {
      item.iconPath = new vscode.ThemeIcon(this.options.icon);
    }
    return item;
  }

  override async getChildren(): Promise<TreeNode[]> {
    try {
      const children = await this.loader();
      return children.length ? children : [new MessageNode(this.options.emptyMessage ?? 'Nothing here', 'info')];
    } catch (error) {
      return [errorNode(error, this.options.what ?? this.label)];
    }
  }
}
