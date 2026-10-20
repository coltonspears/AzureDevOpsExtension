import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

export function initLogger(context: vscode.ExtensionContext): vscode.LogOutputChannel {
  channel = vscode.window.createOutputChannel('Azure DevOps', { log: true });
  context.subscriptions.push(channel);
  return channel;
}

/** Diagnostic logging. Never pass tokens or authorization headers to these functions. */
export const log = {
  info(message: string): void {
    channel?.info(message);
  },
  warn(message: string): void {
    channel?.warn(message);
  },
  error(message: string, error?: unknown): void {
    channel?.error(error === undefined ? message : `${message}: ${error instanceof Error ? error.message : String(error)}`);
  },
  show(): void {
    channel?.show(true);
  },
};
