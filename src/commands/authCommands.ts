import * as vscode from 'vscode';
import { FeatureId, ScopeId, getFeature, scopeLabel } from '../auth/scopes';
import { Services } from '../services';
import { log } from '../util/logger';
import { AccessPanel } from '../webviews/accessPanel';
import { registerCommand } from './register';

export function registerAuthCommands(services: Services): vscode.Disposable[] {
  const { connections, access } = services;
  return [
    registerCommand(services, 'azureDevOps.signIn', 'sign in', () => connections.signIn()),
    registerCommand(services, 'azureDevOps.updatePat', 'update the PAT', () => connections.updatePat()),
    registerCommand(services, 'azureDevOps.signOut', 'sign out', async () => {
      const name = connections.connection?.organization.name;
      if (!name) {
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Sign out of ${name}? Your Personal Access Token will be removed from this machine.`,
        { modal: true },
        'Sign Out',
      );
      if (confirm === 'Sign Out') {
        await connections.signOut();
      }
    }),
    registerCommand(services, 'azureDevOps.switchOrganization', 'switch organization', () => connections.switchOrganization()),
    registerCommand(services, 'azureDevOps.selectProject', 'select a project', async () => {
      if (!connections.isSignedIn) {
        await connections.signIn();
        return;
      }
      await connections.selectProject();
    }),
    registerCommand(services, 'azureDevOps.selectTeam', 'select a team', () => connections.selectTeam()),
    registerCommand(services, 'azureDevOps.showAccess', 'show access', (options?: { afterSignIn?: boolean }) =>
      AccessPanel.show(services, options),
    ),
    registerCommand(services, 'azureDevOps.recheckAccess', 're-check access', () => connections.recheckAccess({ interactive: true })),
    registerCommand(services, 'azureDevOps.openTokenSettings', 'open token settings', async (scope?: ScopeId) => {
      if (typeof scope === 'string') {
        void vscode.window.showInformationMessage(
          `In Azure DevOps, edit your token and enable "${scopeLabel(scope)}". Then run "Azure DevOps: Re-check PAT Scopes" — the token value doesn't change.`,
        );
      }
      await vscode.env.openExternal(vscode.Uri.parse(connections.tokenSettingsUrl()));
    }),
    registerCommand(services, 'azureDevOps.explainScope', 'explain access', (scope: ScopeId, action?: string) =>
      access.explainMissing(scope, action),
    ),
    registerCommand(services, 'azureDevOps.explainFeature', 'explain access', (feature: FeatureId) =>
      access.explainFeature(getFeature(feature)),
    ),
    registerCommand(services, 'azureDevOps.showLog', 'show the log', () => log.show()),
    // Lock-icon variants of toolbar buttons shown when the PAT lacks a scope.
    registerCommand(services, 'azureDevOps.workItems.createLocked', 'explain access', () =>
      access.explainMissing('vso.work_write', 'create work items'),
    ),
    registerCommand(services, 'azureDevOps.pullRequests.createLocked', 'explain access', () =>
      access.explainMissing('vso.code_write', 'create pull requests'),
    ),
    registerCommand(services, 'azureDevOps.pipelines.runLocked', 'explain access', () =>
      access.explainMissing('vso.build_execute', 'run pipelines'),
    ),
  ];
}
