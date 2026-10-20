import * as vscode from 'vscode';
import { Services } from '../services';
import { logGroupRanges, stripLogTimestamps } from '../util/format';
import { log } from '../util/logger';

export const LOG_SCHEME = 'azdo-log';
export const LOG_LANGUAGE = 'azure-pipelines-log';

export interface LogQuery {
  project: string;
  buildId: number;
  logId: number;
  recordId?: string;
  title: string;
}

export function logUri(query: LogQuery): vscode.Uri {
  const name = query.title.replace(/[\\/:*?"<>|#%]+/g, '-').slice(0, 120);
  return vscode.Uri.from({ scheme: LOG_SCHEME, path: `/${query.buildId}/${name}.log`, query: JSON.stringify(query) });
}

function parseLogUri(uri: vscode.Uri): LogQuery | undefined {
  try {
    return JSON.parse(uri.query) as LogQuery;
  } catch {
    return undefined;
  }
}

const POLL_MS = 5000;

/**
 * Serves pipeline logs as read-only documents. While the step that owns a log is still
 * running, the document is refreshed periodically so it behaves like a live tail.
 */
export class LogContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly services: Services) {
    this.disposables.push(
      vscode.workspace.onDidCloseTextDocument(doc => this.stop(doc.uri)),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('azureDevOps.pipelines.showLogTimestamps')) {
          vscode.workspace.textDocuments.filter(d => d.uri.scheme === LOG_SCHEME).forEach(d => this.emitter.fire(d.uri));
        }
      }),
    );
  }

  dispose(): void {
    this.timers.forEach(t => clearTimeout(t));
    this.timers.clear();
    this.emitter.dispose();
    this.disposables.forEach(d => d.dispose());
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const query = parseLogUri(uri);
    if (!query) {
      return '';
    }
    const { api } = this.services.connections.require();
    const [text, timeline] = await Promise.all([
      api.builds.getLog(query.project, query.buildId, query.logId),
      query.recordId ? api.builds.getTimeline(query.project, query.buildId).catch(() => undefined) : undefined,
    ]);
    const record = timeline?.records.find(r => r.id === query.recordId);
    if (record && record.state !== 'completed') {
      this.schedule(uri);
    } else {
      this.stop(uri);
    }
    const showTimestamps = vscode.workspace.getConfiguration('azureDevOps.pipelines').get<boolean>('showLogTimestamps', false);
    const body = showTimestamps ? text : stripLogTimestamps(text);
    const live = record && record.state !== 'completed' ? '\n##[section]… still running, this log refreshes automatically\n' : '';
    return body + live;
  }

  private schedule(uri: vscode.Uri): void {
    const key = uri.toString();
    if (this.timers.has(key)) {
      return;
    }
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        if (vscode.workspace.textDocuments.some(d => d.uri.toString() === key)) {
          this.emitter.fire(uri);
        }
      }, POLL_MS),
    );
  }

  private stop(uri: vscode.Uri): void {
    const key = uri.toString();
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }
}

/** Lets users collapse `##[group]` sections in pipeline logs. */
export class LogFoldingProvider implements vscode.FoldingRangeProvider {
  provideFoldingRanges(document: vscode.TextDocument): vscode.FoldingRange[] {
    const lines: string[] = [];
    for (let i = 0; i < document.lineCount; i++) {
      lines.push(document.lineAt(i).text);
    }
    return logGroupRanges(lines).map(r => new vscode.FoldingRange(r.start, r.end, vscode.FoldingRangeKind.Region));
  }
}

export async function openLog(query: LogQuery): Promise<void> {
  try {
    const document = await vscode.workspace.openTextDocument(logUri(query));
    const withLanguage =
      document.languageId === LOG_LANGUAGE ? document : await vscode.languages.setTextDocumentLanguage(document, LOG_LANGUAGE);
    const editor = await vscode.window.showTextDocument(withLanguage, { preview: true });
    // Jump to the end, where failures usually are.
    const last = withLanguage.lineCount - 1;
    editor.revealRange(new vscode.Range(last, 0, last, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  } catch (error) {
    log.error('Opening log failed', error);
    throw error;
  }
}
