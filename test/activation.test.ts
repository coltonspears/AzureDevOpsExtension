import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import * as vscode from './vscode.stub';
import { activate } from '../src/extension';

interface Manifest {
  contributes: {
    commands: { command: string }[];
    views: Record<string, { id: string }[]>;
    viewsWelcome: { view: string; contents: string }[];
    menus: Record<string, { command: string }[]>;
  };
}

const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as Manifest;
const contributed = new Set(manifest.contributes.commands.map(c => c.command));
const views = new Set(Object.values(manifest.contributes.views).flat().map(v => v.id));

function memento() {
  const data = new Map<string, unknown>();
  return { get: (key: string, fallback?: unknown) => (data.has(key) ? data.get(key) : fallback), update: async (key: string, value: unknown) => void data.set(key, value), keys: () => [...data.keys()] };
}

describe('extension activation', () => {
  const context = {
    subscriptions: [] as { dispose(): void }[],
    globalState: memento(),
    workspaceState: memento(),
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
    extensionUri: vscode.Uri.file('/ext'),
  };
  activate(context as never);

  it('registers every contributed command, and only those', () => {
    const registered = new Set(vscode.registeredCommands.keys());
    expect([...contributed].filter(c => !registered.has(c))).toEqual([]);
    expect([...registered].filter(c => !contributed.has(c))).toEqual([]);
  });

  it('creates every contributed view', () => {
    expect(new Set(vscode.treeViews)).toEqual(views);
  });

  it('only references real commands in menus and welcome views', () => {
    for (const [menu, items] of Object.entries(manifest.contributes.menus)) {
      for (const item of items) {
        expect(contributed.has(item.command), `${menu}: ${item.command}`).toBe(true);
      }
    }
    for (const welcome of manifest.contributes.viewsWelcome) {
      expect(views.has(welcome.view)).toBe(true);
      for (const match of welcome.contents.matchAll(/\(command:([\w.]+)/g)) {
        expect(contributed.has(match[1]), match[1]).toBe(true);
      }
    }
  });

  it('starts signed out with context keys for when clauses', async () => {
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(vscode.contexts.get('azureDevOps.signedIn')).toBe(false);
    expect(vscode.contexts.get('azureDevOps.denied.vso_work')).toBe(false);
  });
});
