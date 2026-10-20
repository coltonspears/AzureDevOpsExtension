import * as vscode from 'vscode';
import { Services } from '../services';
import { reportError } from '../util/reportError';

/** Registers a command whose failures are reported as "Couldn't <action>: …". */
export function registerCommand(
  services: Services,
  id: string,
  action: string,
  handler: (...args: never[]) => unknown,
): vscode.Disposable {
  return vscode.commands.registerCommand(id, async (...args: unknown[]) => {
    try {
      await (handler as (...a: unknown[]) => unknown)(...args);
    } catch (error) {
      await reportError(error, action, services.access);
    }
  });
}
