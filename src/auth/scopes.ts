/**
 * Catalog of Azure DevOps PAT scopes the extension understands, and the user-facing
 * features that depend on them. Pure data + logic so it can be unit tested.
 */

export type ScopeId =
  | 'vso.project'
  | 'vso.work'
  | 'vso.work_write'
  | 'vso.code'
  | 'vso.code_write'
  | 'vso.build'
  | 'vso.build_execute'
  | 'vso.release'
  | 'vso.release_execute'
  | 'vso.wiki'
  | 'vso.wiki_write'
  | 'vso.test'
  | 'vso.packaging'
  | 'vso.identity'
  | 'vso.graph'
  | 'vso.variablegroups_read'
  | 'vso.agentpools'
  | 'vso.serviceendpoint';

export type AccessState = 'granted' | 'denied' | 'unknown';

export interface ScopeDefinition {
  id: ScopeId;
  /** Section name as shown on the Azure DevOps "New Token" page. */
  area: string;
  /** Checkbox label as shown on the Azure DevOps "New Token" page. */
  level: string;
  description: string;
  /** Lower scopes that are always included when this one is granted. */
  implies?: ScopeId[];
}

export const SCOPES: readonly ScopeDefinition[] = [
  { id: 'vso.work', area: 'Work Items', level: 'Read', description: 'Read work items, queries, iterations and comments.' },
  {
    id: 'vso.work_write',
    area: 'Work Items',
    level: 'Read & write',
    implies: ['vso.work'],
    description: 'Create and update work items, links and comments.',
  },
  { id: 'vso.code', area: 'Code', level: 'Read', description: 'Read repositories, branches, pull requests and diffs.' },
  {
    id: 'vso.code_write',
    area: 'Code',
    level: 'Read & write',
    implies: ['vso.code'],
    description: 'Create, vote on, comment on and complete pull requests.',
  },
  { id: 'vso.build', area: 'Build', level: 'Read', description: 'Read pipelines, runs, timelines, logs and approvals.' },
  {
    id: 'vso.build_execute',
    area: 'Build',
    level: 'Read & execute',
    implies: ['vso.build'],
    description: 'Queue, cancel and retry pipeline runs; approve or reject stages.',
  },
  { id: 'vso.release', area: 'Release', level: 'Read', description: 'Read classic release pipelines and releases.' },
  {
    id: 'vso.release_execute',
    area: 'Release',
    level: 'Read, write & execute',
    implies: ['vso.release'],
    description: 'Create and deploy classic releases.',
  },
  { id: 'vso.project', area: 'Project and Team', level: 'Read', description: 'List projects, teams and their settings.' },
  { id: 'vso.identity', area: 'Identity', level: 'Read', description: 'Search for people to assign or add as reviewers.' },
  { id: 'vso.graph', area: 'Graph', level: 'Read', description: 'Read users and groups.' },
  { id: 'vso.wiki', area: 'Wiki', level: 'Read', description: 'Read wikis and wiki pages.' },
  {
    id: 'vso.wiki_write',
    area: 'Wiki',
    level: 'Read & write',
    implies: ['vso.wiki'],
    description: 'Create and edit wiki pages.',
  },
  { id: 'vso.test', area: 'Test Management', level: 'Read', description: 'Read test plans, runs and results.' },
  { id: 'vso.packaging', area: 'Packaging', level: 'Read', description: 'Read Azure Artifacts feeds and packages.' },
  { id: 'vso.variablegroups_read', area: 'Variable Groups', level: 'Read', description: 'Read pipeline variable groups.' },
  { id: 'vso.agentpools', area: 'Agent Pools', level: 'Read', description: 'Read agent pools and agents.' },
  { id: 'vso.serviceendpoint', area: 'Service Connections', level: 'Read', description: 'Read service connections.' },
];

const SCOPE_BY_ID = new Map(SCOPES.map(s => [s.id, s]));

export function getScope(id: ScopeId): ScopeDefinition {
  const scope = SCOPE_BY_ID.get(id);
  if (!scope) {
    throw new Error(`Unknown scope ${id}`);
  }
  return scope;
}

/** e.g. "Work Items (Read & write)" — matches the wording on the Azure DevOps token page. */
export function scopeLabel(id: ScopeId): string {
  const scope = getScope(id);
  return `${scope.area} (${scope.level})`;
}

export type FeatureId =
  | 'workItems.view'
  | 'workItems.edit'
  | 'pullRequests.view'
  | 'pullRequests.contribute'
  | 'pipelines.view'
  | 'pipelines.run'
  | 'releases.view'
  | 'projects.browse'
  | 'people.search'
  | 'repos.browse';

export interface FeatureDefinition {
  id: FeatureId;
  label: string;
  description: string;
  requires: ScopeId[];
}

export const FEATURES: readonly FeatureDefinition[] = [
  {
    id: 'workItems.view',
    label: 'View & query work items',
    description: 'Assigned-to-me lists, sprint view, saved queries and work item details.',
    requires: ['vso.work'],
  },
  {
    id: 'workItems.edit',
    label: 'Create & edit work items',
    description: 'Create work items, change state, assign, edit fields, link and comment.',
    requires: ['vso.work_write'],
  },
  {
    id: 'pullRequests.view',
    label: 'View pull requests',
    description: 'Browse pull requests, changed files, diffs, threads and checks.',
    requires: ['vso.code'],
  },
  {
    id: 'pullRequests.contribute',
    label: 'Create & review pull requests',
    description: 'Create pull requests, vote, comment, resolve threads, complete or abandon.',
    requires: ['vso.code_write'],
  },
  {
    id: 'pipelines.view',
    label: 'View pipelines & logs',
    description: 'Browse pipelines, runs, stage/job/task timelines, live logs and pending approvals.',
    requires: ['vso.build'],
  },
  {
    id: 'pipelines.run',
    label: 'Run & manage pipelines',
    description: 'Queue, re-run, cancel and retry runs; approve or reject stages.',
    requires: ['vso.build_execute'],
  },
  {
    id: 'releases.view',
    label: 'View classic releases',
    description: 'Browse classic release pipelines and their deployments.',
    requires: ['vso.release'],
  },
  {
    id: 'projects.browse',
    label: 'Browse projects & teams',
    description: 'Pick projects and teams from a list instead of typing their names.',
    requires: ['vso.project'],
  },
  {
    id: 'people.search',
    label: 'Search people',
    description: 'Find people when assigning work items or adding pull request reviewers.',
    requires: ['vso.identity'],
  },
  {
    id: 'repos.browse',
    label: 'Browse & clone repositories',
    description: 'List repositories, clone them and open files in the browser.',
    requires: ['vso.code'],
  },
];

const FEATURE_BY_ID = new Map(FEATURES.map(f => [f.id, f]));

export function getFeature(id: FeatureId): FeatureDefinition {
  const feature = FEATURE_BY_ID.get(id);
  if (!feature) {
    throw new Error(`Unknown feature ${id}`);
  }
  return feature;
}

/** Scopes recommended when creating a new PAT so every feature of the extension works. */
export const RECOMMENDED_SCOPES: readonly ScopeId[] = [
  'vso.work_write',
  'vso.code_write',
  'vso.build_execute',
  'vso.release',
  'vso.project',
  'vso.identity',
];

/**
 * Applies the implication rules between scopes: a write scope implies read, and a denied
 * read scope means the write scope cannot be granted either.
 */
export function normalizeStates(states: ReadonlyMap<ScopeId, AccessState>): Map<ScopeId, AccessState> {
  const result = new Map<ScopeId, AccessState>();
  for (const scope of SCOPES) {
    result.set(scope.id, states.get(scope.id) ?? 'unknown');
  }
  for (const scope of SCOPES) {
    if (result.get(scope.id) !== 'granted') {
      continue;
    }
    for (const implied of scope.implies ?? []) {
      result.set(implied, 'granted');
    }
  }
  for (const scope of SCOPES) {
    if (result.get(scope.id) === 'granted') {
      continue;
    }
    if ((scope.implies ?? []).some(implied => result.get(implied) === 'denied')) {
      result.set(scope.id, 'denied');
    }
  }
  return result;
}

/** A feature is denied when any required scope is denied, granted when all are granted. */
export function featureState(feature: FeatureDefinition, states: ReadonlyMap<ScopeId, AccessState>): AccessState {
  const values = feature.requires.map(id => states.get(id) ?? 'unknown');
  if (values.includes('denied')) {
    return 'denied';
  }
  return values.every(v => v === 'granted') ? 'granted' : 'unknown';
}

export interface AccessSummary {
  granted: number;
  denied: number;
  unknown: number;
  total: number;
  /** True when every scope the extension checks is granted (typically a Full access PAT). */
  fullAccess: boolean;
}

export function summarizeFeatures(states: ReadonlyMap<ScopeId, AccessState>): AccessSummary {
  const values = FEATURES.map(f => featureState(f, states));
  return {
    granted: values.filter(v => v === 'granted').length,
    denied: values.filter(v => v === 'denied').length,
    unknown: values.filter(v => v === 'unknown').length,
    total: values.length,
    fullAccess: SCOPES.every(s => states.get(s.id) === 'granted'),
  };
}

/** Context key used in `when` clauses: `azureDevOps.denied.vso_work_write`. */
export function deniedContextKey(id: ScopeId): string {
  return `azureDevOps.denied.${id.replace(/\./g, '_')}`;
}

/** Lists scope changes between two snapshots, used to tell the user what a new PAT changed. */
export function diffStates(
  before: ReadonlyMap<ScopeId, AccessState>,
  after: ReadonlyMap<ScopeId, AccessState>,
): { gained: ScopeId[]; lost: ScopeId[] } {
  const gained: ScopeId[] = [];
  const lost: ScopeId[] = [];
  for (const scope of SCOPES) {
    const was = before.get(scope.id) ?? 'unknown';
    const now = after.get(scope.id) ?? 'unknown';
    if (was !== 'granted' && now === 'granted') {
      gained.push(scope.id);
    } else if (was === 'granted' && now === 'denied') {
      lost.push(scope.id);
    }
  }
  return { gained, lost };
}
