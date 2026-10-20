import type { ScopeId } from '../auth/scopes';
import { AccessDeniedError, AuthenticationError, AzureDevOpsError, extractErrorMessage } from './errors';
import { HttpResponse, HttpTransport } from './http';
import { OrganizationInfo, Service, isOrganizationUrl, serviceUrl } from './urls';

export type QueryValue = string | number | boolean | undefined | null;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  service?: Service;
  /** Path relative to the service base URL. Segments must already be URI-encoded. */
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  contentType?: string;
  accept?: string;
  /** Resource version for preview APIs, e.g. 1 → `7.1-preview.1`. */
  preview?: number;
  /** Omit the api-version parameter. */
  noApiVersion?: boolean;
  /** Scope the endpoint needs; used to learn and report missing access. */
  scope?: ScopeId;
}

export interface ClientHooks {
  onScopeDenied(scope: ScopeId): void;
  onScopeGranted(scope: ScopeId): void;
  onAuthenticationFailed(error: AuthenticationError): void;
}

export interface Page<T> {
  value: T[];
  continuationToken?: string;
}

/** Thin REST client for one organization authenticated with a PAT. */
export class AzureDevOpsClient {
  private readonly authorization: string;
  private tokenCheck?: { at: number; valid: Promise<boolean> };

  constructor(
    readonly organization: OrganizationInfo,
    pat: string,
    private readonly transport: HttpTransport,
    private readonly hooks: ClientHooks,
    readonly apiVersion: string,
  ) {
    this.authorization = `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
  }

  url(options: Pick<RequestOptions, 'service' | 'path' | 'query' | 'preview' | 'noApiVersion'>): string {
    const base = serviceUrl(this.organization, options.service ?? 'core');
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null && value !== '') {
        params.append(key, String(value));
      }
    }
    if (!options.noApiVersion) {
      params.set('api-version', options.preview ? `${this.apiVersion}-preview.${options.preview}` : this.apiVersion);
    }
    const query = params.toString();
    return `${base}/${options.path.replace(/^\//, '')}${query ? `?${query}` : ''}`;
  }

  async json<T>(options: RequestOptions): Promise<T> {
    const response = await this.send(options, options.accept ?? 'application/json');
    if (response.status === 204 || response.body.length === 0) {
      return undefined as T;
    }
    return JSON.parse(response.body.toString('utf8')) as T;
  }

  async text(options: RequestOptions): Promise<string> {
    const response = await this.send(options, options.accept ?? 'text/plain');
    return response.body.toString('utf8');
  }

  async buffer(options: RequestOptions): Promise<Buffer> {
    const response = await this.send(options, options.accept ?? 'application/octet-stream');
    return response.body;
  }

  /** GET a list endpoint and return its `value` plus the continuation token, if any. */
  async page<T>(options: RequestOptions): Promise<Page<T>> {
    const response = await this.send(options, 'application/json');
    const parsed = JSON.parse(response.body.toString('utf8')) as { value: T[] };
    return { value: parsed.value ?? [], continuationToken: response.headers['x-ms-continuationtoken'] };
  }

  /** Follows continuation tokens until `limit` items were read. */
  async all<T>(options: RequestOptions, limit = 5000): Promise<T[]> {
    const items: T[] = [];
    let token: string | undefined;
    do {
      const page = await this.page<T>({ ...options, query: { ...options.query, continuationToken: token } });
      items.push(...page.value);
      token = page.continuationToken;
    } while (token && items.length < limit);
    return items;
  }

  /**
   * Downloads an absolute URL with the PAT, e.g. an image attachment embedded in a work item.
   * Refuses URLs outside the organization so the token is never sent to another site.
   */
  async download(url: string): Promise<{ body: Buffer; contentType: string } | undefined> {
    if (!isOrganizationUrl(this.organization, url)) {
      return undefined;
    }
    const response = await this.transport({
      method: 'GET',
      url,
      headers: { Authorization: this.authorization, Accept: '*/*' },
    });
    if (response.status !== 200) {
      return undefined;
    }
    return { body: response.body, contentType: response.headers['content-type'] ?? 'application/octet-stream' };
  }

  /** Raw request used by the scope probes; bypasses access tracking. */
  async probe(method: string, url: string, body?: string, contentType?: string): Promise<HttpResponse> {
    return this.transport({
      method,
      url,
      body,
      headers: {
        Authorization: this.authorization,
        Accept: 'application/json',
        'X-TFS-FedAuthRedirect': 'Suppress',
        ...(body !== undefined ? { 'Content-Type': contentType ?? 'application/json' } : {}),
      },
      timeoutMs: 30_000,
    });
  }

  private async send(options: RequestOptions, accept: string): Promise<HttpResponse> {
    const url = this.url(options);
    const method = options.method ?? 'GET';
    const headers: Record<string, string> = {
      Authorization: this.authorization,
      Accept: accept,
      'X-TFS-FedAuthRedirect': 'Suppress',
    };
    let body: string | undefined;
    if (options.body !== undefined) {
      body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      headers['Content-Type'] = options.contentType ?? 'application/json';
    }

    const response = await this.transport({ method, url, headers, body });
    const contentType = response.headers['content-type'] ?? '';

    // Azure DevOps serves a sign-in page (203 or HTML) when it rejects the credentials.
    if (response.status === 203 || (response.status === 200 && contentType.includes('text/html') && !accept.includes('html'))) {
      throw this.authenticationFailed(response.status, url);
    }

    if (response.status >= 200 && response.status < 300) {
      if (options.scope) {
        this.hooks.onScopeGranted(options.scope);
      }
      return response;
    }

    const { message, typeKey } = extractErrorMessage(response.body.toString('utf8'));

    if (response.status === 401) {
      if (!(await this.isTokenValid())) {
        throw this.authenticationFailed(response.status, url);
      }
      if (options.scope) {
        this.hooks.onScopeDenied(options.scope);
      }
      throw new AccessDeniedError(message ?? 'Your PAT does not grant access to this resource.', 401, url, options.scope);
    }

    if (response.status === 403) {
      throw new AccessDeniedError(
        message ?? 'Access denied. Your account may not have permission for this action.',
        403,
        url,
        undefined,
      );
    }

    throw new AzureDevOpsError(message ?? `Azure DevOps returned HTTP ${response.status}`, response.status, url, typeKey);
  }

  /** Distinguishes "token is dead" from "token lacks a scope" after a 401. Cached briefly. */
  private isTokenValid(): Promise<boolean> {
    const now = Date.now();
    if (!this.tokenCheck || now - this.tokenCheck.at > 60_000) {
      const valid = this.transport({
        method: 'GET',
        url: `${this.organization.url}/_apis/connectionData`,
        headers: { Authorization: this.authorization, Accept: 'application/json', 'X-TFS-FedAuthRedirect': 'Suppress' },
      }).then(
        r => r.status === 200 && !(r.headers['content-type'] ?? '').includes('text/html'),
        () => true, // network trouble: don't claim the token is invalid
      );
      this.tokenCheck = { at: now, valid };
    }
    return this.tokenCheck.valid;
  }

  private authenticationFailed(status: number, url: string): AuthenticationError {
    const error = new AuthenticationError(
      `Azure DevOps rejected your Personal Access Token for ${this.organization.name}. It may have expired, been revoked, or not be valid for this organization.`,
      status,
      url,
    );
    this.hooks.onAuthenticationFailed(error);
    return error;
  }
}
