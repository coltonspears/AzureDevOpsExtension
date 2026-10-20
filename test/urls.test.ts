import { describe, expect, it } from 'vitest';
import {
  fileWebUrl,
  isOrganizationUrl,
  organizationKey,
  parseGitRemoteUrl,
  parseOrganizationUrl,
  sameOrganization,
  serviceUrl,
  tokenSettingsUrl,
} from '../src/api/urls';

describe('parseOrganizationUrl', () => {
  it('accepts a bare organization name', () => {
    expect(parseOrganizationUrl('contoso')?.organization).toEqual({ url: 'https://dev.azure.com/contoso', name: 'contoso', kind: 'cloud' });
  });

  it('accepts dev.azure.com URLs with or without scheme and deep links', () => {
    expect(parseOrganizationUrl('dev.azure.com/contoso')?.organization.url).toBe('https://dev.azure.com/contoso');
    const deep = parseOrganizationUrl('https://dev.azure.com/contoso/Fabrikam%20Fiber/_workitems/edit/12');
    expect(deep?.organization.name).toBe('contoso');
    expect(deep?.project).toBe('Fabrikam Fiber');
  });

  it('accepts legacy visualstudio.com URLs, ignoring DefaultCollection', () => {
    const parsed = parseOrganizationUrl('https://Contoso.visualstudio.com/DefaultCollection/Web/_git/site');
    expect(parsed?.organization).toEqual({ url: 'https://contoso.visualstudio.com', name: 'contoso', kind: 'legacy' });
    expect(parsed?.project).toBe('Web');
    expect(parsed?.repository).toBe('site');
  });

  it('understands Azure DevOps Server collection URLs', () => {
    const tfs = parseOrganizationUrl('https://tfs.contoso.com/tfs/DefaultCollection/Payments/_git/api');
    expect(tfs?.organization).toEqual({ url: 'https://tfs.contoso.com/tfs/DefaultCollection', name: 'DefaultCollection', kind: 'server' });
    expect(tfs?.project).toBe('Payments');
    const root = parseOrganizationUrl('https://ado.internal:8443/Main');
    expect(root?.organization.url).toBe('https://ado.internal:8443/Main');
  });

  it('rejects garbage', () => {
    expect(parseOrganizationUrl('')).toBeUndefined();
    expect(parseOrganizationUrl('ftp://dev.azure.com/x')).toBeUndefined();
    expect(parseOrganizationUrl('https://dev.azure.com/')).toBeUndefined();
    expect(parseOrganizationUrl('https://dev.azure.com/_apis')).toBeUndefined();
  });
});

describe('parseGitRemoteUrl', () => {
  it.each([
    ['https://contoso@dev.azure.com/contoso/Web/_git/site', 'contoso', 'Web', 'site'],
    ['https://dev.azure.com/contoso/My%20Project/_git/My%20Repo', 'contoso', 'My Project', 'My Repo'],
    ['https://dev.azure.com/contoso/_git/Web', 'contoso', 'Web', 'Web'],
    ['https://contoso.visualstudio.com/Web/_git/site', 'contoso', 'Web', 'site'],
    ['https://contoso.visualstudio.com/DefaultCollection/Web/_git/_optimized/site', 'contoso', 'Web', 'site'],
    ['git@ssh.dev.azure.com:v3/contoso/Web/site', 'contoso', 'Web', 'site'],
    ['ssh://git@ssh.dev.azure.com/v3/contoso/Web/site.git', 'contoso', 'Web', 'site'],
    ['contoso@vs-ssh.visualstudio.com:v3/contoso/Web/site', 'contoso', 'Web', 'site'],
    ['https://tfs.contoso.com/tfs/Coll/Payments/_git/api', 'Coll', 'Payments', 'api'],
    ['ssh://tfs.contoso.com:22/tfs/Coll/Payments/_git/api', 'Coll', 'Payments', 'api'],
  ])('%s', (remote, org, project, repository) => {
    const parsed = parseGitRemoteUrl(remote);
    expect(parsed?.organization.name).toBe(org);
    expect(parsed?.project).toBe(project);
    expect(parsed?.repository).toBe(repository);
  });

  it('ignores remotes that are not Azure Repos', () => {
    expect(parseGitRemoteUrl('git@github.com:contoso/site.git')).toBeUndefined();
    expect(parseGitRemoteUrl('https://github.com/contoso/site')).toBeUndefined();
    expect(parseGitRemoteUrl('https://dev.azure.com/contoso/Web')).toBeUndefined();
  });
});

describe('organization identity and hosts', () => {
  const cloud = parseOrganizationUrl('contoso')!.organization;
  const legacy = parseOrganizationUrl('https://contoso.visualstudio.com')!.organization;
  const server = parseOrganizationUrl('https://tfs.contoso.com/tfs/Coll')!.organization;

  it('treats both cloud URL styles as the same organization', () => {
    expect(organizationKey(cloud)).toBe('cloud:contoso');
    expect(sameOrganization(cloud, legacy)).toBe(true);
    expect(sameOrganization(cloud, server)).toBe(false);
  });

  it('maps services to their hosts', () => {
    expect(serviceUrl(cloud, 'release')).toBe('https://vsrm.dev.azure.com/contoso');
    expect(serviceUrl(cloud, 'identity')).toBe('https://vssps.dev.azure.com/contoso');
    expect(serviceUrl(legacy, 'feeds')).toBe('https://contoso.feeds.visualstudio.com');
    expect(serviceUrl(server, 'release')).toBe('https://tfs.contoso.com/tfs/Coll');
    expect(serviceUrl(cloud, 'profile')).toBe('https://app.vssps.visualstudio.com');
    expect(tokenSettingsUrl(cloud)).toBe('https://dev.azure.com/contoso/_usersSettings/tokens');
  });

  it('only considers URLs of the organization safe for the PAT', () => {
    expect(isOrganizationUrl(cloud, 'https://dev.azure.com/contoso/_apis/wit/attachments/1')).toBe(true);
    expect(isOrganizationUrl(cloud, 'https://contoso.visualstudio.com/_apis/wit/attachments/1')).toBe(true);
    expect(isOrganizationUrl(cloud, 'https://vsrm.dev.azure.com/contoso/x')).toBe(true);
    expect(isOrganizationUrl(cloud, 'https://dev.azure.com/contosoevil/_apis')).toBe(false);
    expect(isOrganizationUrl(cloud, 'https://dev.azure.com/other/_apis')).toBe(false);
    expect(isOrganizationUrl(cloud, 'https://evil.example.com/contoso')).toBe(false);
    expect(isOrganizationUrl(cloud, 'http://dev.azure.com/contoso/x')).toBe(false);
    expect(isOrganizationUrl(server, 'https://tfs.contoso.com/tfs/Coll/_apis')).toBe(true);
    expect(isOrganizationUrl(server, 'https://tfs.contoso.com/tfs/Other/_apis')).toBe(false);
  });
});

describe('fileWebUrl', () => {
  it('links to a branch and line range', () => {
    const url = new URL(fileWebUrl('https://dev.azure.com/contoso/Web/_git/site', 'src/app.ts', 'main', { startLine: 3, endLine: 5, endColumn: 10 }));
    expect(url.searchParams.get('path')).toBe('/src/app.ts');
    expect(url.searchParams.get('version')).toBe('GBmain');
    expect(url.searchParams.get('line')).toBe('3');
    expect(url.searchParams.get('lineEnd')).toBe('5');
  });
});
