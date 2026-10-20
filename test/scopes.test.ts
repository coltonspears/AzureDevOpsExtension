import { describe, expect, it } from 'vitest';
import {
  AccessState,
  FEATURES,
  SCOPES,
  ScopeId,
  deniedContextKey,
  diffStates,
  featureState,
  getFeature,
  normalizeStates,
  scopeLabel,
  summarizeFeatures,
} from '../src/auth/scopes';

const states = (entries: [ScopeId, AccessState][]) => new Map(entries);

describe('scope catalog', () => {
  it('has unique scope ids and features that reference known scopes', () => {
    const ids = SCOPES.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const feature of FEATURES) {
      for (const scope of feature.requires) {
        expect(ids).toContain(scope);
      }
    }
  });

  it('labels scopes the way the Azure DevOps token page does', () => {
    expect(scopeLabel('vso.work_write')).toBe('Work Items (Read & write)');
    expect(scopeLabel('vso.build_execute')).toBe('Build (Read & execute)');
  });

  it('builds context keys usable in when clauses', () => {
    expect(deniedContextKey('vso.code_write')).toBe('azureDevOps.denied.vso_code_write');
  });
});

describe('normalizeStates', () => {
  it('grants read when write is granted', () => {
    const result = normalizeStates(states([['vso.code_write', 'granted']]));
    expect(result.get('vso.code')).toBe('granted');
  });

  it('denies write when read is denied', () => {
    const result = normalizeStates(states([['vso.work', 'denied']]));
    expect(result.get('vso.work_write')).toBe('denied');
  });

  it('defaults everything else to unknown', () => {
    expect(normalizeStates(new Map()).get('vso.wiki')).toBe('unknown');
  });
});

describe('features', () => {
  it('derives feature availability from scopes', () => {
    const s = normalizeStates(states([['vso.work', 'granted'], ['vso.work_write', 'denied']]));
    expect(featureState(getFeature('workItems.view'), s)).toBe('granted');
    expect(featureState(getFeature('workItems.edit'), s)).toBe('denied');
    expect(featureState(getFeature('pipelines.view'), s)).toBe('unknown');
  });

  it('summarizes a full access token', () => {
    const all = new Map(SCOPES.map(s => [s.id, 'granted' as AccessState]));
    const summary = summarizeFeatures(all);
    expect(summary.fullAccess).toBe(true);
    expect(summary.granted).toBe(FEATURES.length);
  });

  it('reports what a replacement token gained and lost', () => {
    const before = states([['vso.code', 'granted'], ['vso.work', 'denied']]);
    const after = states([['vso.code', 'denied'], ['vso.work', 'granted']]);
    expect(diffStates(before, after)).toEqual({ gained: ['vso.work'], lost: ['vso.code'] });
  });
});
