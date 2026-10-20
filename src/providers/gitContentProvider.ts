import * as path from 'path';
import * as vscode from 'vscode';
import { Services } from '../services';

export const GIT_SCHEME = 'azdo-git';

export interface GitFileQuery {
  project: string;
  repositoryId: string;
  /** Blob id; empty for the missing side of an added or deleted file. */
  objectId: string;
  path: string;
  /** Set when the file belongs to a pull request diff (enables review comments). */
  pullRequestId?: number;
  side?: 'left' | 'right';
  changeTrackingId?: number;
  iterationId?: number;
}

export function gitFileUri(query: GitFileQuery): vscode.Uri {
  const prefix = query.pullRequestId ? `/pr-${query.pullRequestId}/${query.side ?? 'right'}` : `/repo`;
  return vscode.Uri.from({
    scheme: GIT_SCHEME,
    path: `${prefix}${query.path.startsWith('/') ? '' : '/'}${query.path}`,
    query: JSON.stringify(query),
  });
}

export function parseGitFileUri(uri: vscode.Uri): GitFileQuery | undefined {
  if (uri.scheme !== GIT_SCHEME) {
    return undefined;
  }
  try {
    return JSON.parse(uri.query) as GitFileQuery;
  } catch {
    return undefined;
  }
}

/** Serves read-only file contents from Azure Repos, used for pull request diffs. */
export class GitContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly services: Services) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const query = parseGitFileUri(uri);
    if (!query || !query.objectId) {
      return '';
    }
    const { api } = this.services.connections.require();
    const content = await api.git.getBlob(query.project, query.repositoryId, query.objectId);
    if (content.subarray(0, 8000).includes(0)) {
      return `Binary file ${path.posix.basename(query.path)} (${content.length.toLocaleString()} bytes) is not shown.`;
    }
    return content.toString('utf8');
  }
}
