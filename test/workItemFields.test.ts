import { describe, expect, it } from 'vitest';
import { WorkItem, WorkItemField, WorkItemTypeField } from '../src/api/types';
import { buildFieldModels, buildPatch, describeRelations, localDate, localMidnightIso } from '../src/webviews/workItemFields';
import { policyChecks, statusChecks } from '../src/webviews/checks';
import { wiqlResultIds } from '../src/api/workItems';
import { workItemMarkdown } from '../src/util/workItemMarkdown';

const definitions = new Map<string, WorkItemField>(
  [
    { referenceName: 'System.State', name: 'State', type: 'string' },
    { referenceName: 'System.Reason', name: 'Reason', type: 'string' },
    { referenceName: 'System.AssignedTo', name: 'Assigned To', type: 'string', isIdentity: true },
    { referenceName: 'System.AreaPath', name: 'Area Path', type: 'treePath' },
    { referenceName: 'System.Tags', name: 'Tags', type: 'plainText' },
    { referenceName: 'System.Description', name: 'Description', type: 'html' },
    { referenceName: 'Microsoft.VSTS.Common.Priority', name: 'Priority', type: 'integer' },
    { referenceName: 'Microsoft.VSTS.Scheduling.StoryPoints', name: 'Story Points', type: 'double' },
    { referenceName: 'Microsoft.VSTS.Scheduling.TargetDate', name: 'Target Date', type: 'dateTime' },
    { referenceName: 'Custom.Team', name: 'Team', type: 'string' },
    { referenceName: 'System.CreatedBy', name: 'Created By', type: 'string', readOnly: true },
  ].map(f => [f.referenceName, f]),
);

const typeFields: WorkItemTypeField[] = [
  { referenceName: 'System.Title', name: 'Title', alwaysRequired: true },
  { referenceName: 'System.State', name: 'State', alwaysRequired: true },
  { referenceName: 'System.Reason', name: 'Reason' },
  { referenceName: 'System.AssignedTo', name: 'Assigned To' },
  { referenceName: 'System.AreaPath', name: 'Area Path' },
  { referenceName: 'System.Tags', name: 'Tags' },
  { referenceName: 'System.Description', name: 'Description' },
  { referenceName: 'Microsoft.VSTS.Common.Priority', name: 'Priority', allowedValues: ['1', '2', '3', '4'] },
  { referenceName: 'Microsoft.VSTS.Scheduling.StoryPoints', name: 'Story Points' },
  { referenceName: 'Microsoft.VSTS.Scheduling.TargetDate', name: 'Target Date' },
  { referenceName: 'Custom.Team', name: 'Team', allowedValues: ['Red', 'Blue'] },
  { referenceName: 'System.CreatedBy', name: 'Created By' },
];

const item: WorkItem = {
  id: 7,
  rev: 3,
  url: '',
  fields: {
    'System.Title': 'Login fails',
    'System.State': 'Active',
    'System.AssignedTo': { displayName: 'Jane Doe', uniqueName: 'jane@contoso.com' },
    'System.AreaPath': 'Web\\Legacy',
    'Microsoft.VSTS.Common.Priority': 2,
    'Microsoft.VSTS.Scheduling.TargetDate': '2026-11-01T00:00:00Z',
    'System.Description': '<p>Broken</p>',
  },
};

const context = {
  typeFields,
  definitions,
  states: [
    { name: 'New', color: 'b2b2b2', category: 'Proposed' },
    { name: 'Active', color: '007acc', category: 'InProgress' },
  ],
  areas: ['Web', 'Web\\Api'],
  iterations: ['Web', 'Web\\Sprint 1'],
};

describe('buildFieldModels', () => {
  const { fields, rich } = buildFieldModels(item, context);
  const byRef = new Map(fields.map(f => [f.refName, f]));

  it('chooses curated, required and custom fields but not system-managed ones', () => {
    expect([...byRef.keys()]).toEqual([
      'System.State',
      'System.Reason',
      'System.AssignedTo',
      'System.AreaPath',
      'Microsoft.VSTS.Common.Priority',
      'Microsoft.VSTS.Scheduling.StoryPoints',
      'Microsoft.VSTS.Scheduling.TargetDate',
      'System.Tags',
      'Custom.Team',
    ]);
  });

  it('picks controls and values per field type', () => {
    expect(byRef.get('System.State')).toMatchObject({ kind: 'select', options: ['New', 'Active'], value: 'Active' });
    expect(byRef.get('System.Reason')?.kind).toBe('readonly');
    expect(byRef.get('System.AssignedTo')).toMatchObject({ kind: 'identity', value: 'Jane Doe <jane@contoso.com>' });
    expect(byRef.get('Microsoft.VSTS.Common.Priority')).toMatchObject({ kind: 'select', value: '2' });
    expect(byRef.get('Microsoft.VSTS.Scheduling.StoryPoints')?.kind).toBe('number');
    expect(byRef.get('Microsoft.VSTS.Scheduling.TargetDate')).toMatchObject({ kind: 'date', value: '2026-11-01' });
    expect(byRef.get('System.Tags')?.kind).toBe('tags');
  });

  it('keeps a current value that is not among the options', () => {
    expect(byRef.get('System.AreaPath')?.options?.[0]).toBe('Web\\Legacy');
  });

  it('returns html fields separately', () => {
    expect(rich).toEqual([{ refName: 'System.Description', name: 'Description', html: '<p>Broken</p>' }]);
  });
});

describe('buildPatch', () => {
  it('converts values by type and guards the revision', () => {
    const patch = buildPatch(item, { 'Microsoft.VSTS.Common.Priority': '1', 'Microsoft.VSTS.Scheduling.StoryPoints': '2.5', 'Microsoft.VSTS.Scheduling.TargetDate': '2026-12-24', 'System.Title': 'New title' }, definitions);
    expect(patch[0]).toEqual({ op: 'test', path: '/rev', value: 3 });
    expect(patch).toContainEqual({ op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: 1 });
    expect(patch).toContainEqual({ op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.StoryPoints', value: 2.5 });
    expect(patch).toContainEqual({ op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.TargetDate', value: '2026-12-24T00:00:00.000Z' });
    expect(patch).toContainEqual({ op: 'add', path: '/fields/System.Title', value: 'New title' });
  });

  it('clears values appropriately', () => {
    const patch = buildPatch(item, { 'System.AssignedTo': '', 'Microsoft.VSTS.Common.Priority': '', 'System.Tags': '' }, definitions);
    expect(patch).toContainEqual({ op: 'add', path: '/fields/System.AssignedTo', value: '' });
    expect(patch).toContainEqual({ op: 'remove', path: '/fields/Microsoft.VSTS.Common.Priority' });
    // Tags were empty already, so nothing to clear.
    expect(patch.some(op => op.path === '/fields/System.Tags')).toBe(false);
  });

  it('rejects invalid numbers', () => {
    expect(() => buildPatch(item, { 'Microsoft.VSTS.Common.Priority': 'high' }, definitions)).toThrow(/not a valid number/);
  });
});

describe('date fields', () => {
  it('shows and saves local calendar dates', () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = 'America/Los_Angeles';
      // 2026-11-01T00:00Z is still October 31st in Los Angeles.
      expect(localDate('2026-11-01T00:00:00Z')).toBe('2026-10-31');
      expect(localMidnightIso('2026-12-24')).toBe('2026-12-24T08:00:00.000Z');
      process.env.TZ = 'Asia/Tokyo';
      expect(localDate('2026-11-01T20:00:00Z')).toBe('2026-11-02');
      expect(localMidnightIso('2026-12-24')).toBe('2026-12-23T15:00:00.000Z');
    } finally {
      process.env.TZ = original;
    }
  });
});

describe('describeRelations', () => {
  it('classifies links', () => {
    const relations = describeRelations([
      { rel: 'System.LinkTypes.Hierarchy-Reverse', url: 'https://dev.azure.com/contoso/_apis/wit/workItems/1' },
      { rel: 'System.LinkTypes.Hierarchy-Forward', url: 'https://dev.azure.com/contoso/_apis/wit/workItems/9' },
      { rel: 'ArtifactLink', url: 'vstfs:///Git/PullRequestId/proj%2Frepo%2F55', attributes: { name: 'Pull Request' } },
      { rel: 'ArtifactLink', url: 'vstfs:///Git/Ref/proj%2Frepo%2FGBfeature%2Flogin', attributes: { name: 'Branch' } },
      { rel: 'Hyperlink', url: 'https://example.com', attributes: { comment: 'Spec' } },
    ]);
    expect(relations.map(r => r.kind)).toEqual(['parent', 'child', 'pullRequest', 'branch', 'hyperlink']);
    expect(relations[2].pullRequestId).toBe(55);
    expect(relations[3].title).toBe('feature/login');
    expect(relations[4].title).toBe('Spec');
  });
});

describe('wiqlResultIds', () => {
  it('reads flat and tree query results without duplicates', () => {
    expect(wiqlResultIds({ queryType: 'flat', workItems: [{ id: 3, url: '' }, { id: 1, url: '' }] })).toEqual([3, 1]);
    expect(
      wiqlResultIds({
        queryType: 'tree',
        workItemRelations: [{ source: null, target: { id: 1 } }, { source: { id: 1 }, target: { id: 2 } }, { source: { id: 1 }, target: { id: 3 } }],
      }),
    ).toEqual([1, 2, 3]);
  });
});

describe('pull request checks', () => {
  it('maps policies and keeps only the latest status per context', () => {
    const policies = policyChecks(
      [
        { evaluationId: 'a', status: 'approved', configuration: { id: 1, isBlocking: true, type: { id: 't', displayName: 'Minimum reviewers' } } },
        { evaluationId: 'b', status: 'running', configuration: { id: 2, isBlocking: true, type: { id: 't', displayName: 'Build' }, settings: { displayName: 'CI' } }, context: { buildId: 9 } },
      ],
      id => `build/${id}`,
    );
    expect(policies).toEqual([
      { name: 'Minimum reviewers', state: 'succeeded', detail: 'approved', blocking: true, url: undefined },
      { name: 'CI', state: 'running', detail: 'running', blocking: true, url: 'build/9' },
    ]);
    const statuses = statusChecks([
      { state: 'pending', context: { name: 'scan', genre: 'sec' }, creationDate: '2026-01-01' },
      { state: 'succeeded', context: { name: 'scan', genre: 'sec' }, creationDate: '2026-01-02', description: 'Security scan' },
    ]);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ name: 'Security scan', state: 'succeeded' });
  });
});

describe('workItemMarkdown', () => {
  it('summarizes a work item for AI chat context', () => {
    const markdown = workItemMarkdown({ ...item, fields: { ...item.fields, 'System.WorkItemType': 'Bug' } }, 'https://x/7', [{ author: 'Bo', text: 'Repro\non Edge' }]);
    expect(markdown).toContain('# Bug 7: Login fails');
    expect(markdown).toContain('- **Assigned to:** Jane Doe');
    expect(markdown).toContain('## Description\n\nBroken');
    expect(markdown).toContain('- **Bo:** Repro on Edge');
  });
});
