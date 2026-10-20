import * as http from 'http';
import { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodeTransport, redirectRequest } from '../src/api/http';

describe('redirectRequest', () => {
  const original = { method: 'GET', url: 'https://dev.azure.com/a', headers: { Authorization: 'Basic x', Accept: '*/*' } };

  it('keeps credentials on the same host', () => {
    const next = redirectRequest(original, new URL(original.url), new URL('https://dev.azure.com/b'), 302);
    expect(next.headers?.Authorization).toBe('Basic x');
  });

  it('drops credentials when redirected to another host', () => {
    const next = redirectRequest(original, new URL(original.url), new URL('https://blob.core.windows.net/x'), 302);
    expect(next.headers?.Authorization).toBeUndefined();
    expect(next.headers?.Accept).toBe('*/*');
  });

  it('drops credentials when redirected from https to http on the same host', () => {
    const next = redirectRequest(original, new URL(original.url), new URL('http://dev.azure.com/a'), 302);
    expect(next.headers?.Authorization).toBeUndefined();
  });

  it('switches to GET for 303 and drops the body', () => {
    const next = redirectRequest({ ...original, method: 'POST', body: '{}' }, new URL(original.url), new URL('https://dev.azure.com/c'), 303);
    expect(next.method).toBe('GET');
    expect(next.body).toBeUndefined();
  });
});

describe('nodeTransport', () => {
  let server: http.Server;
  let base = '';

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: '/target' });
        res.end();
        return;
      }
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-MS-ContinuationToken': 'abc' });
        res.end(JSON.stringify({ method: req.method, url: req.url, body, auth: req.headers.authorization ?? null }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

  it('sends bodies and lower-cases response headers', async () => {
    const response = await nodeTransport({ method: 'POST', url: `${base}/echo`, body: '{"a":1}', headers: { 'Content-Type': 'application/json' } });
    expect(response.status).toBe(200);
    expect(response.headers['x-ms-continuationtoken']).toBe('abc');
    expect(JSON.parse(response.body.toString())).toMatchObject({ method: 'POST', body: '{"a":1}' });
  });

  it('follows same-host redirects with credentials', async () => {
    const response = await nodeTransport({ method: 'GET', url: `${base}/redirect`, headers: { Authorization: 'Basic x' } });
    expect(JSON.parse(response.body.toString())).toMatchObject({ url: '/target', auth: 'Basic x' });
  });
});
