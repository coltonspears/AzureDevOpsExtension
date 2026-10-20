import * as vscode from 'vscode';
import { OrganizationInfo, ParsedGitRemote, parseGitRemoteUrl, sameOrganization } from '../api/urls';
import { log } from '../util/logger';

// Minimal typings for the built-in `vscode.git` extension API (version 1).

export interface GitBranch {
  name?: string;
  commit?: string;
  upstream?: { remote: string; name: string };
  ahead?: number;
  behind?: number;
}

export interface GitRemote {
  name: string;
  fetchUrl?: string;
  pushUrl?: string;
}

export interface GitRepositoryState {
  HEAD: GitBranch | undefined;
  remotes: GitRemote[];
  workingTreeChanges: unknown[];
  indexChanges: unknown[];
  onDidChange: vscode.Event<void>;
}

export interface GitRepository {
  rootUri: vscode.Uri;
  state: GitRepositoryState;
  fetch(remote?: string, ref?: string): Promise<void>;
  push(remoteName?: string, branchName?: string, setUpstream?: boolean): Promise<void>;
  pull(): Promise<void>;
  checkout(treeish: string): Promise<void>;
  createBranch(name: string, checkout: boolean, ref?: string): Promise<void>;
  getBranch(name: string): Promise<GitBranch>;
}

interface GitApi {
  state: 'uninitialized' | 'initialized';
  onDidChangeState: vscode.Event<'uninitialized' | 'initialized'>;
  repositories: GitRepository[];
  getRepository(uri: vscode.Uri): GitRepository | null;
}

interface GitExtension {
  enabled: boolean;
  getAPI(version: 1): GitApi;
}

export interface AzureRemote {
  repository: GitRepository;
  remote: GitRemote;
  parsed: ParsedGitRemote;
}

/** Wraps the built-in git extension to find Azure Repos remotes in the workspace. */
export class GitIntegration {
  private api?: GitApi;

  private async getApi(): Promise<GitApi | undefined> {
    if (this.api) {
      return this.api;
    }
    const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!extension) {
      return undefined;
    }
    try {
      const exports = extension.isActive ? extension.exports : await extension.activate();
      if (!exports.enabled) {
        return undefined;
      }
      const api = exports.getAPI(1);
      if (api.state !== 'initialized') {
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 5000);
          const sub = api.onDidChangeState(state => {
            if (state === 'initialized') {
              clearTimeout(timer);
              sub.dispose();
              resolve();
            }
          });
        });
      }
      this.api = api;
      return api;
    } catch (error) {
      log.warn(`Git extension unavailable: ${String(error)}`);
      return undefined;
    }
  }

  /** All remotes in the workspace that point at Azure Repos. */
  async findAzureRemotes(): Promise<AzureRemote[]> {
    const api = await this.getApi();
    if (!api) {
      return [];
    }
    const results: AzureRemote[] = [];
    for (const repository of api.repositories) {
      for (const remote of repository.state.remotes) {
        const url = remote.fetchUrl ?? remote.pushUrl;
        const parsed = url ? parseGitRemoteUrl(url) : undefined;
        if (parsed) {
          results.push({ repository, remote, parsed });
        }
      }
    }
    return results;
  }

  /**
   * The Azure Repos remote most relevant to the user right now: the repository containing
   * the active editor, preferring the `origin` remote.
   */
  async findActiveRemote(organization?: OrganizationInfo): Promise<AzureRemote | undefined> {
    const remotes = (await this.findAzureRemotes()).filter(
      r => !organization || sameOrganization(r.parsed.organization, organization),
    );
    if (!remotes.length) {
      return undefined;
    }
    const api = await this.getApi();
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const activeRepo = activeUri && api ? api.getRepository(activeUri) : undefined;
    const candidates = activeRepo ? remotes.filter(r => r.repository === activeRepo) : [];
    const pool = candidates.length ? candidates : remotes;
    return pool.find(r => r.remote.name === 'origin') ?? pool[0];
  }

  async repositoryFor(uri: vscode.Uri): Promise<GitRepository | undefined> {
    const api = await this.getApi();
    return api?.getRepository(uri) ?? undefined;
  }

  /** Finds a local clone of the given Azure repository, if one is open. */
  async findLocalClone(project: string, repositoryName: string, organization: OrganizationInfo): Promise<AzureRemote | undefined> {
    const remotes = await this.findAzureRemotes();
    return remotes.find(
      r =>
        sameOrganization(r.parsed.organization, organization) &&
        r.parsed.project.toLowerCase() === project.toLowerCase() &&
        r.parsed.repository.toLowerCase() === repositoryName.toLowerCase(),
    );
  }
}
