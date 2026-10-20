/** Converts branch policies and commit statuses into the checks shown on a pull request. */
import { GitStatus, PolicyEvaluationRecord } from '../api/types';
import { CheckModel } from '../shared/messages';

const POLICY_STATES: Record<string, CheckModel['state']> = {
  approved: 'succeeded',
  rejected: 'failed',
  broken: 'failed',
  running: 'running',
  queued: 'pending',
  notApplicable: 'notApplicable',
};

const STATUS_STATES: Record<GitStatus['state'], CheckModel['state']> = {
  succeeded: 'succeeded',
  failed: 'failed',
  error: 'failed',
  pending: 'pending',
  notSet: 'pending',
  notApplicable: 'notApplicable',
};

export function policyChecks(evaluations: PolicyEvaluationRecord[], buildUrl: (id: number) => string): CheckModel[] {
  return evaluations
    .filter(e => e.configuration.isEnabled !== false)
    .map(e => ({
      name: e.configuration.settings?.displayName || e.configuration.type.displayName,
      state: POLICY_STATES[e.status ?? 'queued'] ?? 'pending',
      detail: e.context?.isExpired ? 'Expired' : e.status,
      blocking: e.configuration.isBlocking !== false,
      url: typeof e.context?.buildId === 'number' ? buildUrl(e.context.buildId) : undefined,
    }));
}

/** Statuses are a history; keep only the latest per context. */
export function statusChecks(statuses: GitStatus[]): CheckModel[] {
  const latest = new Map<string, GitStatus>();
  for (const status of statuses) {
    const key = `${status.context?.genre ?? ''}/${status.context?.name ?? ''}`;
    const existing = latest.get(key);
    if (!existing || (status.creationDate ?? '') > (existing.creationDate ?? '')) {
      latest.set(key, status);
    }
  }
  return [...latest.values()].map(s => ({
    name: s.description || [s.context?.genre, s.context?.name].filter(Boolean).join('/'),
    state: STATUS_STATES[s.state] ?? 'pending',
    detail: s.context?.name,
    blocking: false,
    url: s.targetUrl,
  }));
}
