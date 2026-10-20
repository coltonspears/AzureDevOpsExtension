import { describe, expect, it } from 'vitest';
import {
  branchNameFor,
  duration,
  findWorkItemReferences,
  htmlToText,
  identityName,
  identityUniqueName,
  logGroupRanges,
  parseVariables,
  relativeTime,
  stripLogTimestamps,
  textToHtml,
  titleFromBranch,
  wiqlString,
} from '../src/util/format';

const NOW = Date.parse('2026-10-20T12:00:00Z');

describe('time formatting', () => {
  it('formats relative times', () => {
    expect(relativeTime('2026-10-20T11:59:50Z', NOW)).toBe('just now');
    expect(relativeTime('2026-10-20T11:55:00Z', NOW)).toBe('5 minutes ago');
    expect(relativeTime('2026-10-19T12:00:00Z', NOW)).toBe('1 day ago');
    expect(relativeTime(undefined, NOW)).toBe('');
  });

  it('formats durations', () => {
    expect(duration('2026-10-20T11:00:00Z', '2026-10-20T11:00:42Z')).toBe('42s');
    expect(duration('2026-10-20T11:00:00Z', '2026-10-20T11:03:05Z')).toBe('3m 5s');
    expect(duration('2026-10-20T09:00:00Z', '2026-10-20T11:30:00Z')).toBe('2h 30m');
    expect(duration(null, null)).toBe('');
  });
});

describe('identities', () => {
  it('handles object and legacy string identity values', () => {
    expect(identityName({ displayName: 'Jane Doe', uniqueName: 'jane@contoso.com' })).toBe('Jane Doe');
    expect(identityName('Jane Doe <jane@contoso.com>')).toBe('Jane Doe');
    expect(identityUniqueName('Jane Doe <jane@contoso.com>')).toBe('jane@contoso.com');
    expect(identityName(undefined)).toBe('');
  });
});

describe('html', () => {
  it('converts html to text', () => {
    expect(htmlToText('<p>Hello&nbsp;<b>world</b></p><ul><li>one</li><li>two</li></ul>')).toBe('Hello world\n- one\n- two');
  });

  it('escapes text into paragraphs', () => {
    expect(textToHtml('a < b\nnext\n\nsecond')).toBe('<p>a &lt; b<br>next</p><p>second</p>');
  });
});

describe('wiql', () => {
  it('escapes single quotes', () => {
    expect(wiqlString("O'Brien")).toBe("'O''Brien'");
  });
});

describe('branches and references', () => {
  it('builds branch names from templates', () => {
    expect(branchNameFor('feature/${id}-${title}', 42, 'Fix: Login fails (SSO) ✨', 'Bug')).toBe('feature/42-fix-login-fails-sso');
    expect(branchNameFor('users/me/${type}/${id}', 7, '', 'User Story')).toBe('users/me/user-story/7');
  });

  it('finds work item references', () => {
    expect(findWorkItemReferences('feature/1234-fix-login')).toEqual([1234]);
    expect(findWorkItemReferences('Fixes AB#55 and #66')).toEqual([55, 66]);
    expect(findWorkItemReferences('release/v2')).toEqual([]);
    expect(findWorkItemReferences('release/2024-hotfix')).toEqual([]);
    expect(findWorkItemReferences('hotfix/2026_10')).toEqual([]);
  });

  it('suggests a title from the branch name', () => {
    expect(titleFromBranch('feature/1234-fix-login-page')).toBe('Fix login page');
    expect(titleFromBranch('main')).toBe('Main');
  });
});

describe('pipeline logs', () => {
  it('strips timestamps', () => {
    expect(stripLogTimestamps('2026-10-20T10:00:00.1234567Z ##[section]Starting\n2026-10-20T10:00:01Z done')).toBe('##[section]Starting\ndone');
  });

  it('finds group ranges, including nested groups', () => {
    const lines = ['##[group]Outer', 'a', '##[group]Inner', 'b', '##[endgroup]', '##[endgroup]', 'c'];
    expect(logGroupRanges(lines)).toEqual([
      { start: 2, end: 4 },
      { start: 0, end: 5 },
    ]);
  });

  it('parses queue-time variables', () => {
    expect(parseVariables('a=1; b = two ;param:env=prod; broken')).toEqual({ a: '1', b: 'two', 'param:env': 'prod' });
  });
});
