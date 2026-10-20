import { describe, expect, it } from 'vitest';
import { AccessManager } from '../src/auth/accessManager';
import * as vscode from './vscode.stub';

function memento() {
  const data = new Map<string, unknown>();
  return {
    data,
    get: (key: string, fallback?: unknown) => (data.has(key) ? data.get(key) : fallback),
    update: async (key: string, value: unknown) => void data.set(key, value),
    keys: () => [...data.keys()],
  };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('AccessManager', () => {
  it('learns missing and granted scopes at runtime and exposes them to when clauses', async () => {
    const access = new AccessManager(memento() as never);
    access.load('cloud:contoso');
    let changes = 0;
    access.onDidChange(() => changes++);

    access.markDenied('vso.code_write');
    await flush();
    expect(access.get('vso.code_write')).toBe('denied');
    expect(vscode.contexts.get('azureDevOps.denied.vso_code_write')).toBe(true);
    expect(access.feature('pullRequests.contribute')).toBe('denied');

    access.markGranted('vso.code_write');
    await flush();
    expect(access.get('vso.code')).toBe('granted');
    expect(vscode.contexts.get('azureDevOps.denied.vso_code_write')).toBe(false);
    expect(changes).toBe(2);
  });

  it('keeps runtime knowledge when a later probe cannot decide', () => {
    const access = new AccessManager(memento() as never);
    access.load('cloud:contoso');
    access.markGranted('vso.build');
    access.applyProbeResults([{ scope: 'vso.build', state: 'unknown', detail: 'Select a project' }], undefined);
    expect(access.get('vso.build')).toBe('granted');
    access.applyProbeResults([{ scope: 'vso.build', state: 'denied', status: 401 }], 'Web');
    expect(access.get('vso.build')).toBe('denied');
    expect(access.status('vso.build')).toMatchObject({ status: 401, source: 'probe' });
    expect(access.checkedProject).toBe('Web');
  });

  it('persists per organization and forgets on sign out', async () => {
    const store = memento();
    const first = new AccessManager(store as never);
    first.load('cloud:contoso');
    first.applyProbeResults([{ scope: 'vso.work', state: 'granted', status: 200 }], 'Web');

    const second = new AccessManager(store as never);
    second.load('cloud:contoso');
    expect(second.get('vso.work')).toBe('granted');
    second.load('cloud:other');
    expect(second.get('vso.work')).toBe('unknown');

    second.load('cloud:contoso');
    await second.forget();
    expect(store.data.get('azureDevOps.access:cloud:contoso')).toBeUndefined();
    expect(second.get('vso.work')).toBe('unknown');
  });

  it('lets unknown access through and blocks known-denied actions', async () => {
    const access = new AccessManager(memento() as never);
    access.load('cloud:contoso');
    expect(await access.ensure('vso.work_write', 'edit work items')).toBe(true);
    access.markDenied('vso.work_write');
    expect(await access.ensure('vso.work_write', 'edit work items')).toBe(false);
  });
});
