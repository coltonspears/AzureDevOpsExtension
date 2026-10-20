import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { organizationKey } from '../api/urls';
import { ScopeId, SCOPES } from '../auth/scopes';
import { Services } from '../services';
import { CommonToHost, CommonToWebview } from '../shared/messages';
import { log } from '../util/logger';
import { reportError } from '../util/reportError';

const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Base class for the extension's webview panels: strict CSP, typed messaging, and the
 * shared behaviors (opening links, explaining missing scopes, loading authenticated images).
 */
export abstract class WebviewPanelBase<ToHost extends { type: string }, ToWebview extends { type: string }>
  implements vscode.Disposable
{
  protected readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly disposeEmitter = new vscode.EventEmitter<void>();
  readonly onDidDispose = this.disposeEmitter.event;
  private isDisposed = false;

  /**
   * @param bindToOrganization close the panel when the user switches organization or signs
   * out, so it can never act on another organization's item with the same id.
   */
  constructor(
    protected readonly services: Services,
    viewType: string,
    title: string,
    private readonly script: string,
    bindToOrganization = true,
  ) {
    const extensionUri = services.context.extensionUri;
    this.panel = vscode.window.createWebviewPanel(
      viewType,
      title,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
      },
    );
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'azure-devops-color.svg');
    this.panel.webview.html = this.html();
    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((message: ToHost | CommonToHost) => void this.dispatch(message)),
    );
    const connection = services.connections.connection;
    if (bindToOrganization && connection) {
      const key = organizationKey(connection.organization);
      this.disposables.push(
        services.connections.onDidChange(() => {
          const current = services.connections.connection;
          if (!current || organizationKey(current.organization) !== key) {
            this.dispose();
          }
        }),
      );
    }
  }

  get disposed(): boolean {
    return this.isDisposed;
  }

  reveal(): void {
    this.panel.reveal();
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;
    this.disposeEmitter.fire();
    this.disposeEmitter.dispose();
    this.panel.dispose();
    this.disposables.forEach(d => d.dispose());
  }

  protected track(disposable: vscode.Disposable): void {
    this.disposables.push(disposable);
  }

  protected abstract onReady(): Promise<void> | void;
  protected abstract onMessage(message: ToHost): Promise<void> | void;

  protected post(message: ToWebview | CommonToWebview): void {
    if (!this.isDisposed) {
      void this.panel.webview.postMessage(message);
    }
  }

  protected setTitle(title: string): void {
    this.panel.title = title;
  }

  /** Runs an action with a busy indicator and turns failures into helpful messages. */
  protected async run(label: string, action: () => Promise<void>): Promise<void> {
    this.post({ type: 'busy', busy: true, label });
    try {
      await action();
    } catch (error) {
      await reportError(error, label.toLowerCase(), this.services.access);
    } finally {
      this.post({ type: 'busy', busy: false });
    }
  }

  private async dispatch(message: ToHost | CommonToHost): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          await this.onReady();
          return;
        case 'openUrl': {
          const url = (message as Extract<CommonToHost, { type: 'openUrl' }>).url;
          if (/^https?:\/\//i.test(url)) {
            await vscode.env.openExternal(vscode.Uri.parse(url));
          }
          return;
        }
        case 'requestAccess': {
          const { scope, action } = message as Extract<CommonToHost, { type: 'requestAccess' }>;
          if (SCOPES.some(s => s.id === scope)) {
            await this.services.access.explainMissing(scope as ScopeId, action);
          }
          return;
        }
        case 'resolveImage':
          await this.resolveImage((message as Extract<CommonToHost, { type: 'resolveImage' }>).url);
          return;
        default:
          await this.onMessage(message as ToHost);
      }
    } catch (error) {
      log.error(`Webview message ${message.type} failed`, error);
      await reportError(error, 'complete that action', this.services.access);
    }
  }

  /** Loads images that need the PAT (e.g. work item attachments) and returns them inline. */
  private async resolveImage(url: string): Promise<void> {
    const connection = this.services.connections.connection;
    let dataUri: string | undefined;
    try {
      const result = connection ? await connection.api.client.download(url) : undefined;
      if (result && result.body.length <= MAX_INLINE_IMAGE_BYTES && /^image\//.test(result.contentType)) {
        dataUri = `data:${result.contentType.split(';')[0]};base64,${result.body.toString('base64')}`;
      }
    } catch (error) {
      log.warn(`Image ${url} could not be loaded: ${String(error)}`);
    }
    this.post({ type: 'imageResolved', url, dataUri });
  }

  private html(): string {
    const webview = this.panel.webview;
    const dist = vscode.Uri.joinPath(this.services.context.extensionUri, 'dist');
    const asset = (...parts: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(dist, ...parts)).toString();
    const nonce = randomBytes(16).toString('base64');
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${asset('codicons', 'codicon.css')}">
  <link rel="stylesheet" href="${asset('webview', 'styles.css')}">
</head>
<body>
  <div id="app"><div class="loading"><span class="codicon codicon-loading codicon-modifier-spin"></span> Loading…</div></div>
  <script nonce="${nonce}" src="${asset('webview', `${this.script}.js`)}"></script>
</body>
</html>`;
  }
}
