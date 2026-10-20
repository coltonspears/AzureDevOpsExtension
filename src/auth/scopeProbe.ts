/**
 * Detects which scopes a PAT grants.
 *
 * Azure DevOps has no API that reveals a PAT's scopes to the PAT itself, so each scope is
 * probed with one lightweight request. Azure DevOps checks token scopes before it looks at
 * the target resource or payload, which gives a reliable signal:
 *
 *   - 401           → the token was authenticated but lacks the scope  → denied
 *   - 2xx/400/404…  → the request got past the scope check             → granted
 *
 * Write scopes are probed against targets that cannot exist (id 0, the all-zero GUID) or
 * with `validateOnly=true`, so a probe can never change anything in the organization.
 */

import { OrganizationInfo, serviceUrl } from '../api/urls';
import { AccessState, ScopeId } from './scopes';

export const ZERO_GUID = '00000000-0000-0000-0000-000000000000';

export interface ProbeContext {
  organization: OrganizationInfo;
  /** Project used for project-scoped probes. Those probes report `unknown` without one. */
  project?: string;
  /** Id of the authenticated user, used by identity probes. */
  userId?: string;
  apiVersion: string;
}

export interface ProbeRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT';
  url: string;
  body?: string;
  contentType?: string;
}

export interface ScopeProbe {
  scope: ScopeId;
  requiresProject?: boolean;
  cloudOnly?: boolean;
  build(ctx: ProbeContext & { project: string }): ProbeRequest;
}

export interface ProbeResult {
  scope: ScopeId;
  state: AccessState;
  /** HTTP status of the probe, if one was sent. */
  status?: number;
  detail?: string;
}

export type ProbeSender = (request: ProbeRequest) => Promise<{ status: number; contentType?: string }>;

const enc = encodeURIComponent;

/**
 * Endpoints that were preview-only in some API versions are called with `-preview.1`, which
 * Azure DevOps accepts for preview and GA resources alike. A version error (HTTP 400) would
 * otherwise be mistaken for "granted".
 */
function version(ctx: ProbeContext, preview?: boolean): string {
  return preview ? `${ctx.apiVersion}-preview.1` : ctx.apiVersion;
}

function core(ctx: ProbeContext, path: string, query = '', preview = false): string {
  return `${serviceUrl(ctx.organization, 'core')}/${path}?api-version=${version(ctx, preview)}${query}`;
}

function project(ctx: ProbeContext & { project: string }, path: string, query = '', preview = false): string {
  return core(ctx, `${enc(ctx.project)}/${path}`, query, preview);
}

export const PROBES: readonly ScopeProbe[] = [
  { scope: 'vso.project', build: ctx => ({ method: 'GET', url: core(ctx, '_apis/projects', '&$top=1') }) },
  { scope: 'vso.work', build: ctx => ({ method: 'GET', url: core(ctx, '_apis/wit/fields/System.Title') }) },
  {
    // validateOnly + an empty patch against work item 0: never saves anything.
    scope: 'vso.work_write',
    build: ctx => ({
      method: 'PATCH',
      url: core(ctx, '_apis/wit/workitems/0', '&validateOnly=true'),
      body: '[]',
      contentType: 'application/json-patch+json',
    }),
  },
  { scope: 'vso.code', build: ctx => ({ method: 'GET', url: core(ctx, `_apis/git/repositories/${ZERO_GUID}`) }) },
  {
    scope: 'vso.code_write',
    build: ctx => ({
      method: 'POST',
      url: core(ctx, `_apis/git/repositories/${ZERO_GUID}/pullrequests`),
      body: '{}',
    }),
  },
  {
    scope: 'vso.build',
    requiresProject: true,
    build: ctx => ({ method: 'GET', url: project(ctx, '_apis/build/definitions', '&$top=1') }),
  },
  {
    // Build ids start at 1, so updating build 0 always fails after the scope check.
    scope: 'vso.build_execute',
    requiresProject: true,
    build: ctx => ({ method: 'PATCH', url: project(ctx, '_apis/build/builds/0'), body: '{}' }),
  },
  {
    scope: 'vso.release',
    requiresProject: true,
    build: ctx => ({
      method: 'GET',
      url: `${serviceUrl(ctx.organization, 'release')}/${enc(ctx.project)}/_apis/release/definitions?api-version=${ctx.apiVersion}&$top=1`,
    }),
  },
  {
    scope: 'vso.release_execute',
    requiresProject: true,
    build: ctx => ({
      method: 'PATCH',
      url: `${serviceUrl(ctx.organization, 'release')}/${enc(ctx.project)}/_apis/release/releases/0?api-version=${ctx.apiVersion}`,
      body: '{}',
    }),
  },
  {
    scope: 'vso.identity',
    build: ctx => ({
      method: 'GET',
      url: `${serviceUrl(ctx.organization, 'identity')}/_apis/identities?api-version=${ctx.apiVersion}&identityIds=${enc(ctx.userId ?? ZERO_GUID)}&queryMembership=None`,
    }),
  },
  {
    scope: 'vso.graph',
    cloudOnly: true,
    build: ctx => ({
      method: 'GET',
      url: `${serviceUrl(ctx.organization, 'identity')}/_apis/graph/descriptors/${enc(ctx.userId ?? ZERO_GUID)}?api-version=${version(ctx, true)}`,
    }),
  },
  {
    scope: 'vso.wiki',
    requiresProject: true,
    build: ctx => ({ method: 'GET', url: project(ctx, '_apis/wiki/wikis') }),
  },
  {
    // Writing a page into a wiki that cannot exist.
    scope: 'vso.wiki_write',
    requiresProject: true,
    build: ctx => ({
      method: 'PUT',
      url: project(ctx, `_apis/wiki/wikis/${ZERO_GUID}/pages`, '&path=%2Fazure-devops-scope-probe'),
      body: '{"content":""}',
    }),
  },
  {
    scope: 'vso.test',
    requiresProject: true,
    build: ctx => ({ method: 'GET', url: project(ctx, '_apis/test/runs', '&$top=1') }),
  },
  {
    scope: 'vso.packaging',
    build: ctx => ({ method: 'GET', url: `${serviceUrl(ctx.organization, 'feeds')}/_apis/packaging/feeds?api-version=${version(ctx, true)}` }),
  },
  {
    scope: 'vso.variablegroups_read',
    requiresProject: true,
    build: ctx => ({ method: 'GET', url: project(ctx, '_apis/distributedtask/variablegroups', '&$top=1', true) }),
  },
  {
    scope: 'vso.agentpools',
    build: ctx => ({ method: 'GET', url: core(ctx, '_apis/distributedtask/pools', '&$top=1', true) }),
  },
  {
    scope: 'vso.serviceendpoint',
    requiresProject: true,
    build: ctx => ({ method: 'GET', url: project(ctx, '_apis/serviceendpoint/endpoints', '&$top=1', true) }),
  },
];

/** Interprets the status code of a probe. */
export function classifyProbeResponse(status: number, contentType?: string): { state: AccessState; detail?: string } {
  if (status === 203 || (status === 200 && contentType?.includes('text/html'))) {
    // Azure DevOps answers with a sign-in page when it does not accept the credentials.
    return { state: 'denied', detail: 'Token was not accepted' };
  }
  if (status === 401) {
    return { state: 'denied', detail: 'Scope not granted to this PAT' };
  }
  if (status === 403) {
    return { state: 'denied', detail: 'Access denied (scope or permissions)' };
  }
  if ((status >= 200 && status < 300) || [400, 404, 405, 409, 412, 415, 422].includes(status)) {
    return { state: 'granted' };
  }
  return { state: 'unknown', detail: `Unexpected response (HTTP ${status})` };
}

export async function probeScopes(ctx: ProbeContext, send: ProbeSender): Promise<ProbeResult[]> {
  return Promise.all(
    PROBES.map(async (probe): Promise<ProbeResult> => {
      if (probe.cloudOnly && ctx.organization.kind === 'server') {
        return { scope: probe.scope, state: 'unknown', detail: 'Not available on Azure DevOps Server' };
      }
      if (probe.requiresProject && !ctx.project) {
        return { scope: probe.scope, state: 'unknown', detail: 'Select a project to check this scope' };
      }
      try {
        const response = await send(probe.build({ ...ctx, project: ctx.project ?? '' }));
        return { scope: probe.scope, status: response.status, ...classifyProbeResponse(response.status, response.contentType) };
      } catch (error) {
        return {
          scope: probe.scope,
          state: 'unknown',
          detail: `Could not check: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }),
  );
}
