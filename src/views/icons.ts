import * as vscode from 'vscode';
import { Build, GitPullRequest, TimelineRecord } from '../api/types';

const WORK_ITEM_ICONS: Record<string, [string, string]> = {
  bug: ['bug', 'charts.red'],
  task: ['tasklist', 'charts.yellow'],
  'user story': ['book', 'charts.blue'],
  'product backlog item': ['book', 'charts.blue'],
  requirement: ['book', 'charts.blue'],
  feature: ['rocket', 'charts.purple'],
  epic: ['milestone', 'charts.orange'],
  issue: ['issues', 'charts.purple'],
  impediment: ['warning', 'charts.purple'],
  'test case': ['beaker', 'charts.green'],
  'test plan': ['checklist', 'charts.green'],
  'test suite': ['folder-library', 'charts.green'],
  risk: ['flame', 'charts.orange'],
  'change request': ['diff', 'charts.blue'],
};

export function workItemTypeIcon(type: string): vscode.ThemeIcon {
  const [icon, color] = WORK_ITEM_ICONS[type.toLowerCase()] ?? ['note', 'foreground'];
  return new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
}

const passed = new vscode.ThemeColor('testing.iconPassed');
const failed = new vscode.ThemeColor('testing.iconFailed');
const warning = new vscode.ThemeColor('list.warningForeground');
const muted = new vscode.ThemeColor('disabledForeground');

export function buildIcon(build: Pick<Build, 'status' | 'result'>): vscode.ThemeIcon {
  if (build.status === 'inProgress' || build.status === 'cancelling') {
    return new vscode.ThemeIcon('sync~spin');
  }
  if (build.status === 'notStarted' || build.status === 'postponed') {
    return new vscode.ThemeIcon('clock', muted);
  }
  switch (build.result) {
    case 'succeeded':
      return new vscode.ThemeIcon('pass', passed);
    case 'partiallySucceeded':
      return new vscode.ThemeIcon('warning', warning);
    case 'failed':
      return new vscode.ThemeIcon('error', failed);
    case 'canceled':
      return new vscode.ThemeIcon('circle-slash', muted);
    default:
      return new vscode.ThemeIcon('circle-outline');
  }
}

export function buildStatusText(build: Pick<Build, 'status' | 'result'>): string {
  if (build.status === 'completed') {
    return { succeeded: 'Succeeded', partiallySucceeded: 'Partially succeeded', failed: 'Failed', canceled: 'Canceled', none: 'Completed' }[
      build.result ?? 'none'
    ];
  }
  return { inProgress: 'Running', cancelling: 'Cancelling', notStarted: 'Queued', postponed: 'Postponed', none: '', all: '', completed: '' }[
    build.status
  ];
}

export function timelineIcon(record: TimelineRecord): vscode.ThemeIcon {
  if (record.state === 'inProgress') {
    return new vscode.ThemeIcon('sync~spin');
  }
  if (record.state === 'pending') {
    return new vscode.ThemeIcon('circle-outline', muted);
  }
  switch (record.result) {
    case 'succeeded':
      return new vscode.ThemeIcon('pass', passed);
    case 'succeededWithIssues':
      return new vscode.ThemeIcon('warning', warning);
    case 'failed':
      return new vscode.ThemeIcon('error', failed);
    case 'canceled':
    case 'abandoned':
      return new vscode.ThemeIcon('circle-slash', muted);
    case 'skipped':
      return new vscode.ThemeIcon('debug-step-over', muted);
    default:
      return new vscode.ThemeIcon('circle-outline');
  }
}

export function pullRequestIcon(pr: GitPullRequest): vscode.ThemeIcon {
  if (pr.isDraft) {
    return new vscode.ThemeIcon('git-pull-request-draft', muted);
  }
  if (pr.status === 'completed') {
    return new vscode.ThemeIcon('git-merge', new vscode.ThemeColor('charts.purple'));
  }
  if (pr.status === 'abandoned') {
    return new vscode.ThemeIcon('git-pull-request-closed', muted);
  }
  if (pr.mergeStatus === 'conflicts') {
    return new vscode.ThemeIcon('git-pull-request', failed);
  }
  const votes = pr.reviewers.filter(r => !r.isContainer).map(r => r.vote);
  if (votes.includes(-10)) {
    return new vscode.ThemeIcon('git-pull-request', failed);
  }
  if (votes.includes(-5)) {
    return new vscode.ThemeIcon('git-pull-request', warning);
  }
  if (votes.some(v => v >= 5)) {
    return new vscode.ThemeIcon('git-pull-request', passed);
  }
  return new vscode.ThemeIcon('git-pull-request');
}

export function voteIcon(vote: number): string {
  switch (vote) {
    case 10:
      return '$(pass-filled)';
    case 5:
      return '$(pass)';
    case -5:
      return '$(clock)';
    case -10:
      return '$(error)';
    default:
      return '$(circle-outline)';
  }
}
