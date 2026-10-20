/**
 * Pure helpers for understanding Azure DevOps URLs: organization URLs typed by the
 * user, git remote URLs found in the workspace, and the per-service hosts that the
 * REST API is split across.
 */

export type OrganizationKind = 'cloud' | 'legacy' | 'server';

export interface OrganizationInfo {
  /** Base URL for core REST calls, without a trailing slash (e.g. https://dev.azure.com/contoso). */
  url: string;
  /** Organization name (cloud) or collection name (Azure DevOps Server). */
  name: string;
  kind: OrganizationKind;
}

export interface ParsedLocation {
  organization: OrganizationInfo;
  project?: string;
  repository?: string;
}

export interface ParsedGitRemote extends ParsedLocation {
  project: string;
  repository: string;
}

/** REST services that live on separate hosts in Azure DevOps Services. */
export type Service = 'core' | 'release' | 'identity' | 'feeds' | 'profile';

const ORG_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const LEGACY_HOST = /^([a-z0-9][a-z0-9-]*)\.visualstudio\.com$/i;
const SSH_SCP = /^(?:[^@/]+@)?([^:/]+):(.+)$/;

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function cloudOrg(name: string): OrganizationInfo {
  return { url: `https://dev.azure.com/${encodeURIComponent(name)}`, name, kind: 'cloud' };
}

function legacyOrg(name: string): OrganizationInfo {
  return { url: `https://${name.toLowerCase()}.visualstudio.com`, name, kind: 'legacy' };
}

/** Extracts project / repository from the path segments that follow the organization. */
function projectAndRepository(rest: string[]): { project?: string; repository?: string } {
  const gitIndex = rest.findIndex(s => s.toLowerCase() === '_git');
  if (gitIndex >= 0) {
    const repoSegments = rest
      .slice(gitIndex + 1)
      .filter(s => !['_optimized', '_full'].includes(s.toLowerCase()));
    const repository = stripGitSuffix(repoSegments[0]);
    // `https://dev.azure.com/org/_git/name` is used when the repository is named after its project.
    const project = gitIndex > 0 ? rest[gitIndex - 1] : repository;
    return { project, repository };
  }
  const first = rest[0];
  if (first && !first.startsWith('_')) {
    return { project: first };
  }
  return {};
}

function stripGitSuffix(name: string | undefined): string | undefined {
  if (!name) {
    return undefined;
  }
  return name.toLowerCase().endsWith('.git') ? name.slice(0, -4) : name;
}

/**
 * Parses whatever the user typed for an organization: a bare org name, a dev.azure.com
 * or *.visualstudio.com URL (optionally deep-linking into a project), or an Azure DevOps
 * Server collection URL.
 */
export function parseOrganizationUrl(input: string): ParsedLocation | undefined {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return undefined;
  }
  if (ORG_NAME.test(trimmed) && !trimmed.includes('.')) {
    return { organization: cloudOrg(trimmed) };
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return undefined;
  }

  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean).map(decode);

  if (host === 'dev.azure.com') {
    const [org, ...rest] = segments;
    if (!org || org.startsWith('_')) {
      return undefined;
    }
    return { organization: cloudOrg(org), ...projectAndRepository(rest) };
  }

  const legacy = LEGACY_HOST.exec(host);
  if (legacy) {
    let rest = segments;
    if (rest[0]?.toLowerCase() === 'defaultcollection') {
      rest = rest.slice(1);
    }
    return { organization: legacyOrg(legacy[1]), ...projectAndRepository(rest) };
  }

  return parseServerUrl(url, segments);
}

/**
 * Azure DevOps Server URLs look like https://host/tfs/Collection/Project/_git/Repo or
 * https://host/Collection/Project/... The collection depth is inferred from the
 * conventional `tfs` virtual directory.
 */
function parseServerUrl(url: URL, segments: string[]): ParsedLocation | undefined {
  const collectionDepth = segments[0]?.toLowerCase() === 'tfs' ? 2 : 1;
  if (segments.length < collectionDepth || segments.slice(0, collectionDepth).some(s => s.startsWith('_'))) {
    return undefined;
  }
  const collection = segments.slice(0, collectionDepth);
  const base = `${url.protocol}//${url.host}/${collection.map(encodeURIComponent).join('/')}`;
  const organization: OrganizationInfo = {
    url: base,
    name: collection[collection.length - 1],
    kind: 'server',
  };
  return { organization, ...projectAndRepository(segments.slice(collectionDepth)) };
}

/** Parses an HTTPS or SSH git remote URL that points at an Azure Repos repository. */
export function parseGitRemoteUrl(remote: string): ParsedGitRemote | undefined {
  const text = remote.trim();
  if (!text) {
    return undefined;
  }

  // SSH: git@ssh.dev.azure.com:v3/org/project/repo  or  org@vs-ssh.visualstudio.com:v3/org/project/repo
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    const scp = SSH_SCP.exec(text);
    if (!scp) {
      return undefined;
    }
    return parseSshPath(scp[1].toLowerCase(), scp[2]);
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }

  if (url.protocol === 'ssh:') {
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/^\//, '');
    const result = parseSshPath(host, path);
    if (result) {
      return result;
    }
    // Azure DevOps Server over SSH mirrors the HTTPS path layout.
    url = new URL(`https://${url.hostname}${url.pathname}`);
  }

  const parsed = parseOrganizationUrl(url.toString());
  if (!parsed?.project || !parsed.repository) {
    return undefined;
  }
  return { ...parsed, project: parsed.project, repository: parsed.repository };
}

function parseSshPath(host: string, path: string): ParsedGitRemote | undefined {
  if (host !== 'ssh.dev.azure.com' && host !== 'vs-ssh.visualstudio.com') {
    return undefined;
  }
  const segments = path.split('/').filter(Boolean).map(decode);
  if (segments[0]?.toLowerCase() !== 'v3' || segments.length < 4) {
    return undefined;
  }
  const [, org, project, repo] = segments;
  const repository = stripGitSuffix(repo);
  if (!repository) {
    return undefined;
  }
  const organization = host === 'ssh.dev.azure.com' ? cloudOrg(org) : legacyOrg(org);
  return { organization, project, repository };
}

/**
 * A stable identity for an organization so that e.g. https://contoso.visualstudio.com and
 * https://dev.azure.com/contoso are recognized as the same place.
 */
export function organizationKey(org: OrganizationInfo): string {
  if (org.kind === 'server') {
    return `server:${org.url.toLowerCase()}`;
  }
  return `cloud:${org.name.toLowerCase()}`;
}

export function sameOrganization(a: OrganizationInfo, b: OrganizationInfo): boolean {
  return organizationKey(a) === organizationKey(b);
}

/** Resolves the base URL of the REST service that hosts a given API area. */
export function serviceUrl(org: OrganizationInfo, service: Service): string {
  if (org.kind === 'server' || service === 'core') {
    return org.url;
  }
  const name = encodeURIComponent(org.name);
  if (service === 'profile') {
    return 'https://app.vssps.visualstudio.com';
  }
  const prefix = { release: 'vsrm', identity: 'vssps', feeds: 'feeds' }[service];
  return org.kind === 'cloud'
    ? `https://${prefix}.dev.azure.com/${name}`
    : `https://${org.name.toLowerCase()}.${prefix}.visualstudio.com`;
}

/** The page where users create or edit personal access tokens. */
export function tokenSettingsUrl(org: OrganizationInfo): string {
  return `${org.url}/_usersSettings/tokens`;
}

/** True when a URL lives on one of the organization's own hosts (safe to send the PAT to). */
export function isOrganizationUrl(org: OrganizationInfo, candidate: string): boolean {
  let target: URL;
  try {
    target = new URL(candidate);
  } catch {
    return false;
  }
  if (target.protocol !== 'https:' && !(org.kind === 'server' && target.protocol === 'http:')) {
    return false;
  }
  // A cloud organization is reachable through both its dev.azure.com and *.visualstudio.com URLs.
  const variants = org.kind === 'server' ? [org] : [cloudOrg(org.name), legacyOrg(org.name)];
  const services: Service[] = ['core', 'release', 'identity', 'feeds'];
  return variants.some(variant =>
    services.some(service => {
      const base = new URL(serviceUrl(variant, service));
      if (base.host.toLowerCase() !== target.host.toLowerCase()) {
        return false;
      }
      // dev.azure.com hosts many organizations, so the path must also match.
      const basePath = base.pathname.replace(/\/+$/, '').toLowerCase();
      const targetPath = target.pathname.toLowerCase();
      return basePath === '' || targetPath === basePath || targetPath.startsWith(`${basePath}/`);
    }),
  );
}

export function displayOrganizationUrl(org: OrganizationInfo): string {
  return org.url.replace(/^https?:\/\//, '');
}

/** Builds a web URL to a file (and selected lines) in Azure Repos. */
export function fileWebUrl(
  repositoryWebUrl: string,
  filePath: string,
  branch: string | undefined,
  selection?: { startLine: number; endLine: number; endColumn: number },
): string {
  const params = new URLSearchParams({ path: `/${filePath.replace(/^\/+/, '')}` });
  if (branch) {
    params.set('version', `GB${branch}`);
  }
  if (selection) {
    params.set('line', String(selection.startLine));
    params.set('lineEnd', String(selection.endLine));
    params.set('lineStartColumn', '1');
    params.set('lineEndColumn', String(Math.max(1, selection.endColumn)));
    params.set('lineStyle', 'plain');
    params.set('_a', 'contents');
  }
  return `${repositoryWebUrl}?${params.toString()}`;
}
