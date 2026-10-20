import * as vscode from 'vscode';
import { AzureDevOpsApi } from '../api/api';
import { AzureDevOpsClient } from '../api/client';
import { AuthenticationError, NoProjectError, NotSignedInError } from '../api/errors';
import { nodeTransport } from '../api/http';
import {
  OrganizationInfo,
  OrganizationKind,
  displayOrganizationUrl,
  organizationKey,
  parseOrganizationUrl,
  sameOrganization,
  tokenSettingsUrl,
} from '../api/urls';
import { GitIntegration } from '../git/gitIntegration';
import { log } from '../util/logger';
import { AccessManager } from './accessManager';
import { probeScopes } from './scopeProbe';
import { AccessState, RECOMMENDED_SCOPES, ScopeId, diffStates, scopeLabel, summarizeFeatures } from './scopes';

export interface UserInfo {
  id: string;
  displayName: string;
  email?: string;
}

export interface Connection {
  organization: OrganizationInfo;
  user: UserInfo;
  api: AzureDevOpsApi;
}

/** Everything a command needs to call a project-scoped API. */
export interface ProjectContext extends Connection {
  project: string;
}

interface StoredOrganization {
  url: string;
  name: string;
  kind: OrganizationKind;
  user?: UserInfo;
}

const ORGANIZATIONS_KEY = 'azureDevOps.organizations';
const ACTIVE_KEY = 'azureDevOps.activeOrganization';
const SIGN_IN_PROMPT_DISMISSED_KEY = 'azureDevOps.signInPromptDismissed';
const secretKey = (org: OrganizationInfo) => `azureDevOps.pat:${organizationKey(org)}`;
const projectKey = (org: OrganizationInfo) => `azureDevOps.project:${organizationKey(org)}`;
const teamKey = (org: OrganizationInfo, project: string) => `azureDevOps.team:${organizationKey(org)}:${project.toLowerCase()}`;

const DOCS_URL = 'https://learn.microsoft.com/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate';

/** Owns the PAT, the active organization/project/team, and the sign-in experience. */
export class ConnectionManager implements vscode.Disposable {
  private current?: Connection;
  private currentProject?: string;
  private currentTeam?: string;
  private lastAuthWarning = 0;
  private probeQueue: Promise<void> = Promise.resolve();
  private pendingProbe?: { client: AzureDevOpsClient; project?: string; done: Promise<void> };
  private readonly emitter = new vscode.EventEmitter<void>();
  /** Fires when the organization, user, project or team changes. */
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    readonly access: AccessManager,
    readonly git: GitIntegration,
  ) {}

  dispose(): void {
    this.emitter.dispose();
  }

  get connection(): Connection | undefined {
    return this.current;
  }

  get project(): string | undefined {
    return this.currentProject;
  }

  get team(): string | undefined {
    return this.currentTeam;
  }

  get isSignedIn(): boolean {
    return this.current !== undefined;
  }

  require(): Connection {
    if (!this.current) {
      throw new NotSignedInError();
    }
    return this.current;
  }

  requireProject(): ProjectContext {
    const connection = this.require();
    if (!this.currentProject) {
      throw new NoProjectError();
    }
    return { ...connection, project: this.currentProject };
  }

  tokenSettingsUrl(): string {
    return this.current ? tokenSettingsUrl(this.current.organization) : DOCS_URL;
  }

  // -------------------------------------------------------------------------------------
  // Startup

  async initialize(): Promise<void> {
    await this.updateContext();
    const active = this.context.globalState.get<StoredOrganization>(ACTIVE_KEY);
    if (active) {
      const pat = await this.context.secrets.get(secretKey(active));
      if (pat) {
        await this.restore(active, pat);
        return;
      }
    }
    void this.offerSignInForWorkspace();
  }

  /** Restores a saved session immediately, then re-validates the token in the background. */
  private async restore(stored: StoredOrganization, pat: string): Promise<void> {
    const organization: OrganizationInfo = { url: stored.url, name: stored.name, kind: stored.kind };
    const api = this.createApi(organization, pat);
    this.current = {
      organization,
      api,
      user: stored.user ?? { id: '', displayName: stored.name },
    };
    this.access.load(organizationKey(organization));
    await this.resolveProject(false);
    await this.updateContext();
    this.emitter.fire();

    void (async () => {
      try {
        const user = await this.fetchUser(api);
        if (this.current?.api === api) {
          this.current = { ...this.current, user };
          await this.saveOrganization(organization, user);
          this.emitter.fire();
          await this.recheckAccess({ interactive: false });
        }
      } catch (error) {
        if (!(error instanceof AuthenticationError)) {
          log.warn(`Could not validate saved token: ${String(error)}`);
        }
      }
    })();
  }

  private async offerSignInForWorkspace(): Promise<void> {
    if (this.context.globalState.get<boolean>(SIGN_IN_PROMPT_DISMISSED_KEY)) {
      return;
    }
    const remote = await this.git.findActiveRemote();
    if (!remote || this.current) {
      return;
    }
    const signIn = 'Sign In with PAT';
    const never = "Don't Ask Again";
    const choice = await vscode.window.showInformationMessage(
      `This workspace uses Azure Repos in "${remote.parsed.organization.name}". Sign in to see its work items, pull requests and pipelines.`,
      signIn,
      never,
    );
    if (choice === signIn) {
      await this.signIn(remote.parsed.organization);
    } else if (choice === never) {
      await this.context.globalState.update(SIGN_IN_PROMPT_DISMISSED_KEY, true);
    }
  }

  // -------------------------------------------------------------------------------------
  // Sign in / out

  async signIn(prefill?: OrganizationInfo): Promise<boolean> {
    const organization = prefill ?? (await this.pickOrganization());
    if (!organization) {
      return false;
    }
    const pat = await this.promptForPat(organization);
    if (!pat) {
      return false;
    }
    return this.connect(organization, pat, true);
  }

  /** Replaces the PAT of the current organization and reports what access changed. */
  async updatePat(): Promise<boolean> {
    if (!this.current) {
      return this.signIn();
    }
    const organization = this.current.organization;
    const pat = await this.promptForPat(organization, true);
    if (!pat) {
      return false;
    }
    return this.connect(organization, pat, true);
  }

  async signOut(): Promise<void> {
    if (!this.current) {
      return;
    }
    const organization = this.current.organization;
    await this.context.secrets.delete(secretKey(organization));
    await this.context.globalState.update(ACTIVE_KEY, undefined);
    await this.access.forget();
    this.current = undefined;
    this.currentProject = undefined;
    this.currentTeam = undefined;
    await this.updateContext();
    this.emitter.fire();
    void vscode.window.showInformationMessage(
      `Signed out of ${organization.name}. Your Personal Access Token was removed from secure storage.`,
    );
  }

  async switchOrganization(): Promise<void> {
    const saved = this.savedOrganizations();
    const items: (vscode.QuickPickItem & { org?: StoredOrganization; add?: boolean })[] = saved.map(org => ({
      label: `$(organization) ${org.name}`,
      description: displayOrganizationUrl(org),
      detail: org.user ? `Signed in as ${org.user.displayName}` : undefined,
      org,
    }));
    items.push({ label: '$(add) Add organization…', add: true });
    const pick = await vscode.window.showQuickPick(items, {
      title: 'Azure DevOps: Switch Organization',
      placeHolder: this.current ? `Current: ${this.current.organization.name}` : 'Choose an organization',
    });
    if (!pick) {
      return;
    }
    if (pick.add || !pick.org) {
      await this.signIn();
      return;
    }
    const pat = await this.context.secrets.get(secretKey(pick.org));
    if (!pat) {
      await this.signIn(pick.org);
      return;
    }
    await this.connect(pick.org, pat, false);
  }

  // -------------------------------------------------------------------------------------
  // Project & team

  async selectProject(): Promise<boolean> {
    const connection = this.require();
    let project: string | undefined;
    if (this.access.get('vso.project') !== 'denied') {
      try {
        const projects = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: 'Loading projects…' },
          () => connection.api.core.listProjects(),
        );
        const pick = await vscode.window.showQuickPick(
          projects
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(p => ({
              label: p.name,
              description: p.name === this.currentProject ? '(current)' : undefined,
              detail: p.description,
            })),
          { title: 'Azure DevOps: Select Project', placeHolder: 'Choose the project to work with', matchOnDetail: true },
        );
        if (!pick) {
          return false;
        }
        project = pick.label;
      } catch (error) {
        log.warn(`Listing projects failed: ${String(error)}`);
      }
    }
    if (!project) {
      project = await vscode.window.showInputBox({
        title: 'Azure DevOps: Select Project',
        prompt:
          this.access.get('vso.project') === 'denied'
            ? 'Your PAT lacks "Project and Team (Read)", so projects cannot be listed. Type the project name.'
            : 'Type the project name',
        value: this.currentProject,
        ignoreFocusOut: true,
        validateInput: v => (v.trim() ? undefined : 'Enter a project name'),
      });
      if (!project) {
        return false;
      }
      project = project.trim();
    }
    await this.setProject(project);
    return true;
  }

  async setProject(project: string): Promise<void> {
    const connection = this.require();
    this.currentProject = project;
    await this.context.workspaceState.update(projectKey(connection.organization), project);
    await this.context.globalState.update(projectKey(connection.organization), project);
    this.currentTeam = this.context.workspaceState.get<string>(teamKey(connection.organization, project));
    await this.updateContext();
    this.emitter.fire();
    // Project-scoped scopes (Build, Release, Wiki, ...) can only be checked once a project is known.
    if (this.access.checkedProject?.toLowerCase() !== project.toLowerCase()) {
      void this.recheckAccess({ interactive: false });
    }
  }

  async selectTeam(): Promise<void> {
    const { api, project, organization } = this.requireProject();
    const teams = await api.core.listTeams(project);
    const pick = await vscode.window.showQuickPick(
      [
        { label: '$(organization) Default team', team: undefined as string | undefined },
        ...teams.sort((a, b) => a.name.localeCompare(b.name)).map(t => ({ label: t.name, description: t.description, team: t.name })),
      ],
      { title: 'Azure DevOps: Select Team', placeHolder: 'The team whose current iteration is shown' },
    );
    if (!pick) {
      return;
    }
    this.currentTeam = pick.team;
    await this.context.workspaceState.update(teamKey(organization, project), pick.team);
    this.emitter.fire();
  }

  // -------------------------------------------------------------------------------------
  // Access

  /**
   * Probes every scope again. Interactive runs show progress and a summary. Runs are
   * serialized, and a request for the same token and project joins the run in flight.
   */
  async recheckAccess(options: { interactive: boolean; previous?: ReadonlyMap<ScopeId, AccessState> }): Promise<void> {
    const connection = this.current;
    if (!connection) {
      return;
    }
    const before = options.previous ?? new Map(this.access.states());
    const project = this.currentProject;
    let pending = this.pendingProbe;
    if (!pending || pending.client !== connection.api.client || pending.project !== project) {
      const done = this.probeQueue.then(() => this.runProbes(connection, project, options.interactive));
      this.probeQueue = done.catch(() => undefined);
      const run = { client: connection.api.client, project, done };
      this.pendingProbe = pending = run;
      done
        .finally(() => {
          if (this.pendingProbe === run) {
            this.pendingProbe = undefined;
          }
        })
        .catch(() => undefined);
    }
    await pending.done;
    if (options.interactive && this.current === connection) {
      this.reportAccess(before);
    }
  }

  private async runProbes(connection: Connection, project: string | undefined, interactive: boolean): Promise<void> {
    if (this.current !== connection) {
      return;
    }
    this.access.setChecking(true);
    try {
      const run = () =>
        probeScopes(
          {
            organization: connection.organization,
            project,
            userId: connection.user.id || undefined,
            apiVersion: connection.api.client.apiVersion,
          },
          async request => {
            const response = await connection.api.client.probe(request.method, request.url, request.body, request.contentType);
            return { status: response.status, contentType: response.headers['content-type'] };
          },
        );
      const results = interactive
        ? await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Checking which scopes your PAT grants…' },
            run,
          )
        : await run();
      if (this.current !== connection) {
        return;
      }
      for (const r of results) {
        log.info(`Scope ${r.scope}: ${r.state}${r.status ? ` (HTTP ${r.status})` : ''}${r.detail ? ` — ${r.detail}` : ''}`);
      }
      this.access.applyProbeResults(results, project);
    } finally {
      this.access.setChecking(false);
    }
  }

  private reportAccess(before: ReadonlyMap<ScopeId, AccessState>): void {
    const summary = summarizeFeatures(this.access.states());
    const { gained, lost } = diffStates(before, this.access.states());
    const parts: string[] = [];
    if (summary.fullAccess) {
      parts.push('Your PAT grants every scope the extension uses.');
    } else {
      parts.push(`${summary.granted} of ${summary.total} features are available with this PAT.`);
    }
    const knewBefore = [...before.values()].some(state => state !== 'unknown');
    if (gained.length && knewBefore) {
      parts.push(`Newly granted: ${gained.map(scopeLabel).join(', ')}.`);
    }
    if (lost.length) {
      parts.push(`No longer granted: ${lost.map(scopeLabel).join(', ')}.`);
    }
    const show = 'Show Access Details';
    const notify = summary.denied ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    void notify(parts.join(' '), show).then(choice => {
      if (choice === show) {
        void vscode.commands.executeCommand('azureDevOps.showAccess');
      }
    });
  }

  // -------------------------------------------------------------------------------------
  // Internals

  private createApi(organization: OrganizationInfo, pat: string): AzureDevOpsApi {
    const apiVersion =
      organization.kind === 'server'
        ? vscode.workspace.getConfiguration('azureDevOps').get<string>('server.apiVersion', '7.0')
        : '7.1';
    const client = new AzureDevOpsClient(
      organization,
      pat,
      nodeTransport,
      {
        onScopeDenied: scope => {
          if (this.current?.api.client === client) {
            this.access.markDenied(scope);
          }
        },
        onScopeGranted: scope => {
          if (this.current?.api.client === client) {
            this.access.markGranted(scope);
          }
        },
        onAuthenticationFailed: () => {
          if (this.current?.api.client === client) {
            this.warnTokenRejected();
          }
        },
      },
      apiVersion,
    );
    return new AzureDevOpsApi(client);
  }

  private warnTokenRejected(): void {
    const now = Date.now();
    if (now - this.lastAuthWarning < 5 * 60_000 || !this.current) {
      return;
    }
    this.lastAuthWarning = now;
    const update = 'Update PAT';
    const signOut = 'Sign Out';
    void vscode.window
      .showErrorMessage(
        `Azure DevOps rejected the Personal Access Token for ${this.current.organization.name}. It may have expired or been revoked.`,
        update,
        signOut,
      )
      .then(choice => {
        if (choice === update) {
          void this.updatePat();
        } else if (choice === signOut) {
          void this.signOut();
        }
      });
  }

  private async fetchUser(api: AzureDevOpsApi): Promise<UserInfo> {
    const data = await api.core.connectionData();
    const user = data.authenticatedUser;
    const anonymous =
      !user?.id ||
      user.descriptor?.includes('UnauthenticatedIdentity') === true ||
      user.providerDisplayName === 'Anonymous';
    if (anonymous) {
      throw new AuthenticationError('The token was not accepted.', 401, api.organization.url);
    }
    return {
      id: user.id,
      displayName: user.providerDisplayName,
      email: user.properties?.Account?.$value,
    };
  }

  private async connect(organization: OrganizationInfo, pat: string, interactive: boolean): Promise<boolean> {
    const api = this.createApi(organization, pat);
    let user: UserInfo;
    try {
      user = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Verifying your Personal Access Token for ${organization.name}…` },
        () => this.fetchUser(api),
      );
    } catch (error) {
      const retry = 'Try Again';
      const message =
        error instanceof AuthenticationError
          ? `Azure DevOps did not accept that token for ${displayOrganizationUrl(organization)}. Check that it hasn't expired and that it was created for this organization (or "All accessible organizations").`
          : `Could not reach ${displayOrganizationUrl(organization)}: ${error instanceof Error ? error.message : String(error)}`;
      const choice = await vscode.window.showErrorMessage(message, retry);
      if (choice === retry) {
        return this.signIn(organization);
      }
      return false;
    }

    const tokenChanged = (await this.context.secrets.get(secretKey(organization))) !== pat;
    await this.context.secrets.store(secretKey(organization), pat);
    await this.saveOrganization(organization, user);
    await this.context.globalState.update(ACTIVE_KEY, { url: organization.url, name: organization.name, kind: organization.kind, user });

    const switchedOrg = !this.current || !sameOrganization(this.current.organization, organization);
    this.current = { organization, user, api };
    if (switchedOrg) {
      // The previous organization's project and team mean nothing here.
      this.currentProject = undefined;
      this.currentTeam = undefined;
      this.access.load(organizationKey(organization));
    }
    // Remember what the old token could do (to report what changed), then forget it:
    // nothing learned about a different token applies to this one.
    const previous = tokenChanged ? new Map(this.access.states()) : undefined;
    if (tokenChanged) {
      await this.access.reset();
    }
    await this.resolveProject(interactive);
    await this.updateContext();
    this.emitter.fire();
    log.info(`Signed in to ${organization.url} as ${user.displayName}`);

    await this.recheckAccess({ interactive, previous });
    if (interactive) {
      await vscode.commands.executeCommand('azureDevOps.showAccess', { afterSignIn: true });
    }
    return true;
  }

  /** Workspace choice → git remote of the workspace → last project used in this organization. */
  private async resolveProject(interactive: boolean): Promise<void> {
    const connection = this.current;
    if (!connection) {
      return;
    }
    const remote = await this.git.findActiveRemote(connection.organization);
    let project =
      this.context.workspaceState.get<string>(projectKey(connection.organization)) ??
      remote?.parsed.project ??
      this.context.globalState.get<string>(projectKey(connection.organization));
    if (!project && this.access.get('vso.project') !== 'denied') {
      try {
        const projects = await connection.api.core.listProjects();
        if (projects.length === 1) {
          project = projects[0].name;
        }
      } catch {
        // Fall through to asking the user.
      }
    }
    if (project) {
      this.currentProject = project;
      this.currentTeam = this.context.workspaceState.get<string>(teamKey(connection.organization, project));
      await this.context.globalState.update(projectKey(connection.organization), project);
    } else if (interactive) {
      await this.selectProject();
    }
  }

  private savedOrganizations(): StoredOrganization[] {
    return this.context.globalState.get<StoredOrganization[]>(ORGANIZATIONS_KEY, []);
  }

  private async saveOrganization(organization: OrganizationInfo, user: UserInfo): Promise<void> {
    const others = this.savedOrganizations().filter(o => !sameOrganization(o, organization));
    await this.context.globalState.update(ORGANIZATIONS_KEY, [
      { url: organization.url, name: organization.name, kind: organization.kind, user },
      ...others,
    ]);
  }

  private async pickOrganization(): Promise<OrganizationInfo | undefined> {
    type Item = vscode.QuickPickItem & { org?: OrganizationInfo; manual?: boolean };
    const items: Item[] = [];
    const seen = new Set<string>();
    for (const remote of await this.git.findAzureRemotes()) {
      const key = organizationKey(remote.parsed.organization);
      if (!seen.has(key)) {
        seen.add(key);
        items.push({
          label: `$(repo) ${remote.parsed.organization.name}`,
          description: displayOrganizationUrl(remote.parsed.organization),
          detail: `Detected from the "${remote.remote.name}" remote of ${remote.parsed.repository}`,
          org: remote.parsed.organization,
        });
      }
    }
    for (const org of this.savedOrganizations()) {
      const key = organizationKey(org);
      if (!seen.has(key)) {
        seen.add(key);
        items.push({ label: `$(organization) ${org.name}`, description: displayOrganizationUrl(org), detail: 'Used before', org });
      }
    }
    if (items.length) {
      items.push({ label: '$(edit) Enter organization URL…', manual: true });
      const pick = await vscode.window.showQuickPick(items, {
        title: 'Azure DevOps: Sign In (1/2) — Organization',
        placeHolder: 'Which organization do you want to connect to?',
        ignoreFocusOut: true,
      });
      if (!pick) {
        return undefined;
      }
      if (pick.org) {
        return pick.org;
      }
    }
    const input = await vscode.window.showInputBox({
      title: 'Azure DevOps: Sign In (1/2) — Organization',
      prompt: 'Organization name or URL, e.g. "contoso", https://dev.azure.com/contoso, or an Azure DevOps Server collection URL',
      placeHolder: 'https://dev.azure.com/your-organization',
      ignoreFocusOut: true,
      validateInput: value => (parseOrganizationUrl(value) ? undefined : 'Enter an organization name or a valid URL'),
    });
    return input ? parseOrganizationUrl(input)?.organization : undefined;
  }

  private promptForPat(organization: OrganizationInfo, replacing = false): Promise<string | undefined> {
    return new Promise(resolve => {
      const input = vscode.window.createInputBox();
      const createButton: vscode.QuickInputButton = {
        iconPath: new vscode.ThemeIcon('link-external'),
        tooltip: 'Create or edit a PAT in the browser',
      };
      const docsButton: vscode.QuickInputButton = {
        iconPath: new vscode.ThemeIcon('question'),
        tooltip: 'How Personal Access Tokens work',
      };
      input.title = `Azure DevOps: ${replacing ? 'Update' : 'Sign In (2/2) —'} Personal Access Token for ${organization.name}`;
      input.password = true;
      input.ignoreFocusOut = true;
      input.placeholder = 'Paste your Personal Access Token';
      input.prompt = `Recommended scopes: ${RECOMMENDED_SCOPES.map(scopeLabel).join(', ')}. The token is kept in your OS keychain.`;
      input.buttons = [createButton, docsButton];
      let done = false;
      const finish = (value: string | undefined) => {
        if (!done) {
          done = true;
          resolve(value);
          input.dispose();
        }
      };
      input.onDidTriggerButton(button => {
        const url = button === createButton ? tokenSettingsUrl(organization) : DOCS_URL;
        void vscode.env.openExternal(vscode.Uri.parse(url));
      });
      input.onDidChangeValue(value => {
        input.validationMessage = /\s/.test(value.trim()) ? 'A PAT cannot contain spaces' : undefined;
      });
      input.onDidAccept(() => {
        const value = input.value.trim();
        if (!value || /\s/.test(value)) {
          input.validationMessage = 'Paste a Personal Access Token';
          return;
        }
        finish(value);
      });
      input.onDidHide(() => finish(undefined));
      input.show();
    });
  }

  private async updateContext(): Promise<void> {
    await vscode.commands.executeCommand('setContext', 'azureDevOps.signedIn', this.isSignedIn);
    await vscode.commands.executeCommand('setContext', 'azureDevOps.hasProject', this.isSignedIn && !!this.currentProject);
  }
}
