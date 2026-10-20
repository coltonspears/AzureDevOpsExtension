import { describe, expect, it } from 'vitest';
import { PROBES, ProbeRequest, ZERO_GUID, classifyProbeResponse, probeScopes } from '../src/auth/scopeProbe';
import { parseOrganizationUrl } from '../src/api/urls';

const cloud = parseOrganizationUrl('contoso')!.organization;
const server = parseOrganizationUrl('https://tfs.contoso.com/tfs/Coll')!.organization;
const context = { organization: cloud, project: 'Web', userId: 'user-1', apiVersion: '7.1' };

describe('classifyProbeResponse', () => {
  it.each([
    [200, 'granted'],
    [204, 'granted'],
    [400, 'granted'],
    [404, 'granted'],
    [409, 'granted'],
    [401, 'denied'],
    [403, 'denied'],
    [203, 'denied'],
    [500, 'unknown'],
  ] as const)('HTTP %i → %s', (status, state) => {
    expect(classifyProbeResponse(status).state).toBe(state);
  });

  it('treats an HTML sign-in page as not accepted', () => {
    expect(classifyProbeResponse(200, 'text/html; charset=utf-8').state).toBe('denied');
  });
});

describe('probes are non-destructive', () => {
  const requests = PROBES.map(p => ({ scope: p.scope, request: p.build({ ...context, project: 'Web' }) }));

  it('only writes to targets that cannot exist or in validate-only mode', () => {
    for (const { scope, request } of requests) {
      if (request.method === 'GET') {
        continue;
      }
      const safe =
        request.url.includes(ZERO_GUID) ||
        /\/(workitems|builds|releases)\/0\?/.test(request.url) ||
        request.url.includes('validateOnly=true');
      expect(safe, `${scope}: ${request.method} ${request.url}`).toBe(true);
    }
  });

  it('never uses DELETE', () => {
    expect(requests.some(r => (r.request.method as string) === 'DELETE')).toBe(false);
  });

  it('includes an api-version on every request', () => {
    for (const { request } of requests) {
      expect(request.url).toMatch(/api-version=7\.1(-preview\.1)?(&|$)/);
    }
  });
});

describe('probeScopes', () => {
  /** Simulates a PAT with Work Items read and Code read/write only. */
  const fakeServer = async (request: ProbeRequest) => {
    const granted = ['/_apis/wit/fields', '/_apis/git/repositories/'];
    if (request.url.includes('/_apis/wit/workitems/0')) {
      return { status: 401 };
    }
    if (granted.some(g => request.url.includes(g))) {
      return { status: request.method === 'GET' ? 404 : 400 };
    }
    return { status: 401 };
  };

  it('maps responses to scope states', async () => {
    const results = new Map((await probeScopes(context, fakeServer)).map(r => [r.scope, r.state]));
    expect(results.get('vso.work')).toBe('granted');
    expect(results.get('vso.work_write')).toBe('denied');
    expect(results.get('vso.code')).toBe('granted');
    expect(results.get('vso.code_write')).toBe('granted');
    expect(results.get('vso.build')).toBe('denied');
  });

  it('skips project-scoped probes without a project', async () => {
    const sent: string[] = [];
    const results = await probeScopes({ ...context, project: undefined }, async r => {
      sent.push(r.url);
      return { status: 200 };
    });
    expect(results.find(r => r.scope === 'vso.build')?.state).toBe('unknown');
    expect(sent.some(url => url.includes('/build/'))).toBe(false);
  });

  it('skips cloud-only probes on Azure DevOps Server', async () => {
    const results = await probeScopes({ ...context, organization: server }, async () => ({ status: 200 }));
    expect(results.find(r => r.scope === 'vso.graph')?.state).toBe('unknown');
    expect(results.find(r => r.scope === 'vso.work')?.state).toBe('granted');
  });

  it('reports network failures as unknown instead of denied', async () => {
    const results = await probeScopes(context, async () => {
      throw new Error('ECONNRESET');
    });
    expect(results.every(r => r.state === 'unknown')).toBe(true);
  });
});
