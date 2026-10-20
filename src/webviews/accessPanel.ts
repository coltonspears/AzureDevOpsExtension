import * as vscode from 'vscode';
import { displayOrganizationUrl } from '../api/urls';
import { FEATURES, RECOMMENDED_SCOPES, SCOPES, scopeLabel, summarizeFeatures } from '../auth/scopes';
import { Services } from '../services';
import { AccessToHost, AccessToWebview, AccessViewState } from '../shared/messages';
import { WebviewPanelBase } from './panelBase';

/** Shows exactly which scopes the PAT grants and which features that unlocks. */
export class AccessPanel extends WebviewPanelBase<AccessToHost, AccessToWebview> {
  private static current?: AccessPanel;
  private afterSignIn = false;

  static show(services: Services, options: { afterSignIn?: boolean } = {}): void {
    if (AccessPanel.current && !AccessPanel.current.disposed) {
      AccessPanel.current.afterSignIn = options.afterSignIn ?? false;
      AccessPanel.current.reveal();
      AccessPanel.current.pushState();
      return;
    }
    const panel = new AccessPanel(services);
    panel.afterSignIn = options.afterSignIn ?? false;
    AccessPanel.current = panel;
  }

  private constructor(services: Services) {
    super(services, 'azureDevOps.access', 'Azure DevOps: PAT Access', 'access');
    this.track(services.access.onDidChange(() => this.pushState()));
    this.track(services.connections.onDidChange(() => this.pushState()));
  }

  protected onReady(): void {
    this.pushState();
  }

  protected async onMessage(message: AccessToHost): Promise<void> {
    switch (message.type) {
      case 'refresh':
        this.pushState();
        break;
      case 'recheck':
        this.afterSignIn = false;
        await this.services.connections.recheckAccess({ interactive: true });
        break;
      case 'updatePat':
        await vscode.commands.executeCommand('azureDevOps.updatePat');
        break;
      case 'signIn':
        await vscode.commands.executeCommand('azureDevOps.signIn');
        break;
      case 'signOut':
        await vscode.commands.executeCommand('azureDevOps.signOut');
        break;
      case 'selectProject':
        await vscode.commands.executeCommand('azureDevOps.selectProject');
        break;
      case 'openTokenSettings':
        await vscode.commands.executeCommand('azureDevOps.openTokenSettings');
        break;
      case 'copyRecommended':
        await vscode.env.clipboard.writeText(RECOMMENDED_SCOPES.map(scopeLabel).join('\n'));
        this.post({ type: 'toast', kind: 'info', message: 'Recommended scopes copied to the clipboard' });
        break;
    }
  }

  private pushState(): void {
    this.post({ type: 'state', state: this.buildState() });
  }

  private buildState(): AccessViewState {
    const { connections, access } = this.services;
    const connection = connections.connection;
    const states = access.states();
    return {
      signedIn: !!connection,
      afterSignIn: this.afterSignIn,
      checking: access.checking,
      organization: connection
        ? { name: connection.organization.name, url: displayOrganizationUrl(connection.organization), kind: connection.organization.kind }
        : undefined,
      user: connection ? { name: connection.user.displayName, email: connection.user.email } : undefined,
      project: connections.project,
      checkedAt: access.checkedAt,
      checkedProject: access.checkedProject,
      tokenSettingsUrl: connections.tokenSettingsUrl(),
      fullAccess: summarizeFeatures(states).fullAccess,
      features: FEATURES.map(f => ({
        id: f.id,
        label: f.label,
        description: f.description,
        state: access.feature(f.id),
        requires: f.requires.map(id => ({ id, label: scopeLabel(id), state: access.get(id) })),
      })),
      scopes: SCOPES.map(s => {
        const status = access.status(s.id);
        return {
          id: s.id,
          area: s.area,
          level: s.level,
          description: s.description,
          state: access.get(s.id),
          detail: status?.detail,
          status: status?.status,
          source: status?.source,
        };
      }),
      recommended: RECOMMENDED_SCOPES.map(scopeLabel),
    };
  }
}
