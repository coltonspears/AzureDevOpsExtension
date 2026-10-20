import type * as vscode from 'vscode';
import type { AccessManager } from './auth/accessManager';
import type { ConnectionManager } from './auth/connectionManager';
import type { GitIntegration } from './git/gitIntegration';

/** Shared singletons handed to views, panels and commands. */
export interface Services {
  context: vscode.ExtensionContext;
  connections: ConnectionManager;
  access: AccessManager;
  git: GitIntegration;
}
