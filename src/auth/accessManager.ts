import * as vscode from 'vscode';
import { ProbeResult } from './scopeProbe';
import {
  AccessState,
  FeatureDefinition,
  FeatureId,
  SCOPES,
  ScopeId,
  deniedContextKey,
  featureState,
  getFeature,
  normalizeStates,
  scopeLabel,
} from './scopes';

export interface ScopeStatus {
  state: AccessState;
  /** HTTP status the probe received. */
  status?: number;
  detail?: string;
  /** `probe` when found by the sign-in check, `runtime` when learned from a real request. */
  source: 'probe' | 'runtime';
}

interface PersistedAccess {
  checkedAt?: number;
  project?: string;
  scopes: Partial<Record<ScopeId, ScopeStatus>>;
}

/**
 * Tracks which PAT scopes are granted for the signed-in organization, persists that
 * knowledge, exposes it to `when` clauses, and guides the user when access is missing.
 */
export class AccessManager implements vscode.Disposable {
  private statuses = new Map<ScopeId, ScopeStatus>();
  private storageKey?: string;
  private normalized = normalizeStates(new Map());
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  checkedAt?: number;
  checkedProject?: string;
  checking = false;

  constructor(private readonly memento: vscode.Memento) {
    this.updateContextKeys();
  }

  dispose(): void {
    this.emitter.dispose();
  }

  /** Switches to the stored knowledge for an organization (or clears it). */
  load(organizationKey: string | undefined): void {
    this.storageKey = organizationKey ? `azureDevOps.access:${organizationKey}` : undefined;
    const stored = this.storageKey ? this.memento.get<PersistedAccess>(this.storageKey) : undefined;
    this.statuses = new Map(Object.entries(stored?.scopes ?? {}) as [ScopeId, ScopeStatus][]);
    this.checkedAt = stored?.checkedAt;
    this.checkedProject = stored?.project;
    this.changed(false);
  }

  /** Forgets everything for the current organization (used on sign out). */
  async forget(): Promise<void> {
    if (this.storageKey) {
      await this.memento.update(this.storageKey, undefined);
    }
    this.load(undefined);
  }

  /** Clears everything known for the current organization, e.g. after the PAT was replaced. */
  async reset(): Promise<void> {
    this.statuses.clear();
    this.checkedAt = undefined;
    this.checkedProject = undefined;
    this.changed(true);
  }

  setChecking(checking: boolean): void {
    this.checking = checking;
    this.emitter.fire();
  }

  applyProbeResults(results: ProbeResult[], project: string | undefined): void {
    for (const result of results) {
      const previous = this.statuses.get(result.scope);
      // Keep what is already known about this token when a probe could not decide
      // (timeouts, server errors, no project selected). Knowledge about a previous
      // token is cleared by reset() when the PAT changes.
      if (result.state === 'unknown' && previous && previous.state !== 'unknown') {
        continue;
      }
      this.statuses.set(result.scope, {
        state: result.state,
        status: result.status,
        detail: result.detail,
        source: 'probe',
      });
    }
    this.checkedAt = Date.now();
    this.checkedProject = project;
    this.changed(true);
  }

  /** Called by the REST client when a request needing `scope` was rejected with 401. */
  markDenied(scope: ScopeId): void {
    if (this.statuses.get(scope)?.state === 'denied') {
      return;
    }
    this.statuses.set(scope, { state: 'denied', detail: 'A request needing this scope was rejected', source: 'runtime' });
    this.changed(true);
  }

  /** Called by the REST client when a request needing `scope` succeeded. */
  markGranted(scope: ScopeId): void {
    if (this.normalized.get(scope) === 'granted') {
      return;
    }
    this.statuses.set(scope, { state: 'granted', source: 'runtime' });
    this.changed(true);
  }

  get(scope: ScopeId): AccessState {
    return this.normalized.get(scope) ?? 'unknown';
  }

  status(scope: ScopeId): ScopeStatus | undefined {
    const raw = this.statuses.get(scope);
    const effective = this.get(scope);
    if (raw && raw.state === effective) {
      return raw;
    }
    if (effective !== 'unknown') {
      return { state: effective, detail: 'Implied by a related scope', source: raw?.source ?? 'probe' };
    }
    return raw;
  }

  states(): ReadonlyMap<ScopeId, AccessState> {
    return this.normalized;
  }

  isDenied(scope: ScopeId): boolean {
    return this.get(scope) === 'denied';
  }

  feature(id: FeatureId): AccessState {
    return featureState(getFeature(id), this.normalized);
  }

  deniedScopes(): ScopeId[] {
    return SCOPES.filter(s => this.get(s.id) === 'denied').map(s => s.id);
  }

  /**
   * Gate for actions: returns false (after explaining what is missing) when the PAT is
   * known to lack `scope`. Unknown access is allowed through; the server will decide.
   */
  async ensure(scope: ScopeId, action: string): Promise<boolean> {
    if (!this.isDenied(scope)) {
      return true;
    }
    void this.explainMissing(scope, action);
    return false;
  }

  async explainMissing(scope: ScopeId, action?: string): Promise<void> {
    const label = scopeLabel(scope);
    const what = action ? `To ${action}, your` : 'Your';
    const message = `${what} Personal Access Token needs the "${label}" scope, which it doesn't currently grant.`;
    const editScopes = 'Edit PAT Scopes';
    const recheck = 'Re-check Access';
    const replace = 'Use a Different PAT';
    const details = 'Show Access';
    const choice = await vscode.window.showWarningMessage(message, editScopes, recheck, replace, details);
    if (choice === editScopes) {
      await vscode.commands.executeCommand('azureDevOps.openTokenSettings', scope);
    } else if (choice === recheck) {
      await vscode.commands.executeCommand('azureDevOps.recheckAccess');
    } else if (choice === replace) {
      await vscode.commands.executeCommand('azureDevOps.updatePat');
    } else if (choice === details) {
      await vscode.commands.executeCommand('azureDevOps.showAccess');
    }
  }

  async explainFeature(feature: FeatureDefinition): Promise<void> {
    const missing = feature.requires.filter(s => this.isDenied(s));
    if (missing.length) {
      await this.explainMissing(missing[0], feature.label.toLowerCase());
      return;
    }
    const state = this.feature(feature.id);
    const scopes = feature.requires.map(scopeLabel).join(', ');
    const text =
      state === 'granted'
        ? `"${feature.label}" is available. It uses the ${scopes} scope.`
        : `"${feature.label}" needs the ${scopes} scope. It hasn't been verified yet — select a project and re-check access.`;
    await vscode.window.showInformationMessage(text);
  }

  private changed(persist: boolean): void {
    this.normalized = normalizeStates(new Map([...this.statuses].map(([id, s]) => [id, s.state])));
    this.updateContextKeys();
    if (persist && this.storageKey) {
      const scopes: Partial<Record<ScopeId, ScopeStatus>> = {};
      for (const [id, status] of this.statuses) {
        scopes[id] = status;
      }
      void this.memento.update(this.storageKey, { checkedAt: this.checkedAt, project: this.checkedProject, scopes });
    }
    this.emitter.fire();
  }

  private updateContextKeys(): void {
    for (const scope of SCOPES) {
      void vscode.commands.executeCommand('setContext', deniedContextKey(scope.id), this.get(scope.id) === 'denied');
    }
  }
}
