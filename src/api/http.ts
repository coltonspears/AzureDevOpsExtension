import * as http from 'http';
import * as https from 'https';

export interface HttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  body: Buffer;
}

export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Transport built on Node's http/https modules. VS Code (and Cursor) patch these modules
 * to honour the editor's proxy settings, which global fetch does not do on every version.
 */
export const nodeTransport: HttpTransport = request => send(request, 0);

function send(request: HttpRequest, redirects: number): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(request.url);
    const lib = url.protocol === 'http:' ? http : https;
    const body =
      request.body === undefined
        ? undefined
        : Buffer.isBuffer(request.body)
          ? request.body
          : Buffer.from(request.body, 'utf8');
    const headers: Record<string, string | number> = { ...request.headers };
    if (body) {
      headers['Content-Length'] = body.length;
    }

    const req = lib.request(url, { method: request.method, headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (location && [301, 302, 303, 307, 308].includes(status) && redirects < MAX_REDIRECTS) {
          resolve(send(redirectRequest(request, url, new URL(location, url), status), redirects + 1));
          return;
        }
        const flat: Record<string, string> = {};
        for (const [key, value] of Object.entries(res.headers)) {
          if (value !== undefined) {
            flat[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
          }
        }
        resolve({ status, headers: flat, body: Buffer.concat(chunks) });
      });
    });

    req.setTimeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS, () => {
      req.destroy(new Error(`Request to ${url.host} timed out`));
    });
    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

/** Builds the follow-up request for a redirect, never forwarding credentials to another host. */
export function redirectRequest(original: HttpRequest, from: URL, to: URL, status: number): HttpRequest {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(original.headers ?? {})) {
    if (key.toLowerCase() === 'authorization' && to.host.toLowerCase() !== from.host.toLowerCase()) {
      continue;
    }
    headers[key] = value;
  }
  const switchToGet = status === 303 || ((status === 301 || status === 302) && original.method !== 'GET');
  return {
    ...original,
    url: to.toString(),
    headers,
    method: switchToGet ? 'GET' : original.method,
    body: switchToGet ? undefined : original.body,
  };
}
