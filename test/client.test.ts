import { describe, expect, it, vi } from 'vitest';
import { AzureDevOpsClient } from '../src/api/client';
import { AccessDeniedError, AuthenticationError, AzureDevOpsError } from '../src/api/errors';
import { HttpRequest, HttpResponse } from '../src/api/http';
import { parseOrganizationUrl } from '../src/api/urls';

const org = parseOrganizationUrl('contoso')!.organization;

function json(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  return { status, headers: { 'content-type': 'application/json', ...headers }, body: Buffer.from(JSON.stringify(body)) };
}

function setup(handler: (request: HttpRequest) => HttpResponse) {
  const requests: HttpRequest[] = [];
  const hooks = { onScopeDenied: vi.fn(), onScopeGranted: vi.fn(), onAuthenticationFailed: vi.fn() };
  const client = new AzureDevOpsClient(org, 'secret-pat', async r => (requests.push(r), handler(r)), hooks, '7.1');
  return { client, hooks, requests };
}

describe('AzureDevOpsClient', () => {
  it('builds URLs with api-version, preview versions and skips empty query values', () => {
    const { client } = setup(() => json(200, {}));
    expect(client.url({ path: 'Web/_apis/wit/wiql', query: { $top: 5, team: undefined, x: '' } })).toBe(
      'https://dev.azure.com/contoso/Web/_apis/wit/wiql?%24top=5&api-version=7.1',
    );
    expect(client.url({ path: '_apis/x', preview: 3 })).toContain('api-version=7.1-preview.3');
    expect(client.url({ service: 'release', path: 'Web/_apis/release/definitions' })).toMatch(/^https:\/\/vsrm\.dev\.azure\.com\/contoso\//);
  });

  it('sends the PAT as basic auth and reports granted scopes', async () => {
    const { client, hooks, requests } = setup(() => json(200, { value: [1] }));
    await client.json({ path: '_apis/projects', scope: 'vso.project' });
    expect(requests[0].headers?.Authorization).toBe(`Basic ${Buffer.from(':secret-pat').toString('base64')}`);
    expect(requests[0].headers?.['X-TFS-FedAuthRedirect']).toBe('Suppress');
    expect(hooks.onScopeGranted).toHaveBeenCalledWith('vso.project');
  });

  it('turns 401 with a valid token into a missing-scope error', async () => {
    const { client, hooks } = setup(r => (r.url.includes('connectionData') ? json(200, {}) : json(401, { message: 'TF400813' })));
    const error = await client.json({ path: '_apis/build/builds', scope: 'vso.build' }).catch(e => e);
    expect(error).toBeInstanceOf(AccessDeniedError);
    expect((error as AccessDeniedError).scope).toBe('vso.build');
    expect(hooks.onScopeDenied).toHaveBeenCalledWith('vso.build');
    expect(hooks.onAuthenticationFailed).not.toHaveBeenCalled();
  });

  it('turns 401 with a dead token into an authentication error', async () => {
    const { client, hooks } = setup(() => json(401, {}));
    const error = await client.json({ path: '_apis/projects', scope: 'vso.project' }).catch(e => e);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(hooks.onAuthenticationFailed).toHaveBeenCalled();
    expect(hooks.onScopeDenied).not.toHaveBeenCalled();
  });

  it('treats a sign-in page as an authentication failure', async () => {
    const { client } = setup(() => ({ status: 203, headers: { 'content-type': 'text/html' }, body: Buffer.from('<html>') }));
    await expect(client.json({ path: '_apis/projects' })).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('surfaces Azure DevOps error messages', async () => {
    const { client } = setup(() => json(400, { message: 'TF401019: The Git repository does not exist' }));
    const error = await client.json({ path: '_apis/git/repositories/x' }).catch(e => e);
    expect(error).toBeInstanceOf(AzureDevOpsError);
    expect((error as Error).message).toContain('TF401019');
  });

  it('follows continuation tokens', async () => {
    const { client, requests } = setup(r =>
      r.url.includes('continuationToken=page2') ? json(200, { value: [3] }) : json(200, { value: [1, 2] }, { 'x-ms-continuationtoken': 'page2' }),
    );
    expect(await client.all({ path: '_apis/projects' })).toEqual([1, 2, 3]);
    expect(requests).toHaveLength(2);
  });

  it('never sends the PAT to a foreign host when downloading', async () => {
    const { client, requests } = setup(() => ({ status: 200, headers: { 'content-type': 'image/png' }, body: Buffer.from('png') }));
    expect(await client.download('https://evil.example.com/a.png')).toBeUndefined();
    expect(requests).toHaveLength(0);
    expect((await client.download('https://dev.azure.com/contoso/_apis/wit/attachments/1'))?.contentType).toBe('image/png');
  });
});
