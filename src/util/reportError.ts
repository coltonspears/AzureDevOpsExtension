import * as vscode from 'vscode';
import { AccessDeniedError, AuthenticationError, NoProjectError, NotSignedInError } from '../api/errors';
import type { AccessManager } from '../auth/accessManager';
import { log } from './logger';

/** Shows a helpful message for a failed action. `action` reads like "load pull requests". */
export async function reportError(error: unknown, action: string, access?: AccessManager): Promise<void> {
  if (error instanceof NotSignedInError) {
    const signIn = 'Sign In';
    if ((await vscode.window.showInformationMessage(`Sign in to Azure DevOps to ${action}.`, signIn)) === signIn) {
      await vscode.commands.executeCommand('azureDevOps.signIn');
    }
    return;
  }
  if (error instanceof NoProjectError) {
    const select = 'Select Project';
    if ((await vscode.window.showInformationMessage(`Select an Azure DevOps project to ${action}.`, select)) === select) {
      await vscode.commands.executeCommand('azureDevOps.selectProject');
    }
    return;
  }
  if (error instanceof AuthenticationError) {
    // The connection manager already offers to update the PAT (throttled).
    log.warn(`Could not ${action}: ${error.message}`);
    vscode.window.setStatusBarMessage(`$(error) Azure DevOps: PAT rejected — could not ${action}`, 8000);
    return;
  }
  if (error instanceof AccessDeniedError) {
    if (error.scope && access) {
      await access.explainMissing(error.scope, action);
      return;
    }
    log.warn(`Access denied while trying to ${action}: ${error.message}`);
    void vscode.window.showWarningMessage(`Couldn't ${action}. ${error.message}`);
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  log.error(`Could not ${action}`, error);
  void vscode.window.showErrorMessage(`Couldn't ${action}: ${message}`);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
