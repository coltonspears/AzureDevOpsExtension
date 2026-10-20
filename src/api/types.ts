/** Subset of the Azure DevOps REST API contracts used by the extension. */

export interface IdentityRef {
  id: string;
  displayName: string;
  uniqueName?: string;
  imageUrl?: string;
  descriptor?: string;
  isContainer?: boolean;
}

export interface ListResponse<T> {
  count?: number;
  value: T[];
}

export interface ConnectionData {
  authenticatedUser: {
    id: string;
    descriptor?: string;
    subjectDescriptor?: string;
    providerDisplayName: string;
    isActive?: boolean;
    properties?: Record<string, { $type?: string; $value?: string }>;
  };
  instanceId?: string;
  deploymentType?: string;
}

export interface TeamProject {
  id: string;
  name: string;
  description?: string;
  state?: string;
  visibility?: string;
  lastUpdateTime?: string;
  defaultTeam?: { id: string; name: string };
}

export interface WebApiTeam {
  id: string;
  name: string;
  description?: string;
}

export interface Identity {
  id: string;
  descriptor?: string;
  subjectDescriptor?: string;
  providerDisplayName: string;
  customDisplayName?: string;
  isActive?: boolean;
  isContainer?: boolean;
  properties?: Record<string, { $type?: string; $value?: string }>;
}

// ---------------------------------------------------------------------------------------
// Work items

export interface WorkItemRelation {
  rel: string;
  url: string;
  attributes?: { name?: string; comment?: string; isLocked?: boolean; [key: string]: unknown };
}

export interface WorkItem {
  id: number;
  rev: number;
  fields: Record<string, unknown>;
  relations?: WorkItemRelation[];
  url: string;
  _links?: { html?: { href: string } };
}

export interface WorkItemStateColor {
  name: string;
  color: string;
  category: string;
}

export interface WorkItemType {
  name: string;
  referenceName: string;
  description?: string;
  color?: string;
  icon?: { id: string; url: string };
  isDisabled?: boolean;
  states?: WorkItemStateColor[];
}

export interface WorkItemTypeCategory {
  name: string;
  referenceName: string;
  defaultWorkItemType?: { name: string };
  workItemTypes: { name: string }[];
}

export interface WorkItemTypeField {
  referenceName: string;
  name: string;
  alwaysRequired?: boolean;
  allowedValues?: string[];
  defaultValue?: unknown;
  helpText?: string;
}

export interface WorkItemField {
  referenceName: string;
  name: string;
  type: string;
  readOnly?: boolean;
  isIdentity?: boolean;
  isPicklist?: boolean;
}

export interface QueryHierarchyItem {
  id: string;
  name: string;
  path: string;
  isFolder?: boolean;
  hasChildren?: boolean;
  isPublic?: boolean;
  queryType?: 'flat' | 'tree' | 'oneHop';
  children?: QueryHierarchyItem[];
}

export interface WiqlResult {
  queryType: 'flat' | 'tree' | 'oneHop';
  workItems?: { id: number; url: string }[];
  workItemRelations?: { source?: { id: number } | null; target?: { id: number } | null; rel?: string | null }[];
}

export interface WorkItemComment {
  id: number;
  text: string;
  createdBy: IdentityRef;
  createdDate: string;
  modifiedDate?: string;
}

export interface WorkItemCommentList {
  totalCount: number;
  count: number;
  comments: WorkItemComment[];
}

export interface ClassificationNode {
  id: number;
  name: string;
  structureType?: 'area' | 'iteration';
  hasChildren?: boolean;
  children?: ClassificationNode[];
  path?: string;
}

export interface TeamIteration {
  id: string;
  name: string;
  path: string;
  attributes?: { startDate?: string; finishDate?: string; timeFrame?: string };
}

export interface JsonPatchOperation {
  op: 'add' | 'replace' | 'remove' | 'test';
  path: string;
  value?: unknown;
}

// ---------------------------------------------------------------------------------------
// Git

export interface GitRepository {
  id: string;
  name: string;
  url: string;
  project: { id: string; name: string };
  defaultBranch?: string;
  remoteUrl?: string;
  sshUrl?: string;
  webUrl?: string;
  isDisabled?: boolean;
  size?: number;
}

export interface GitRef {
  name: string;
  objectId: string;
}

export type PullRequestStatus = 'active' | 'abandoned' | 'completed' | 'notSet' | 'all';

export interface IdentityRefWithVote extends IdentityRef {
  vote: number;
  isRequired?: boolean;
  hasDeclined?: boolean;
  isFlagged?: boolean;
}

export interface GitPullRequestCompletionOptions {
  mergeStrategy?: 'noFastForward' | 'squash' | 'rebase' | 'rebaseMerge';
  deleteSourceBranch?: boolean;
  transitionWorkItems?: boolean;
  mergeCommitMessage?: string;
  bypassPolicy?: boolean;
  bypassReason?: string;
}

export interface GitPullRequest {
  pullRequestId: number;
  codeReviewId?: number;
  status: PullRequestStatus;
  createdBy: IdentityRef;
  creationDate: string;
  closedDate?: string;
  title: string;
  description?: string;
  sourceRefName: string;
  targetRefName: string;
  mergeStatus?: 'notSet' | 'queued' | 'conflicts' | 'succeeded' | 'rejectedByPolicy' | 'failure';
  isDraft?: boolean;
  reviewers: IdentityRefWithVote[];
  labels?: { id?: string; name: string; active?: boolean }[];
  repository: GitRepository;
  lastMergeSourceCommit?: { commitId: string };
  lastMergeTargetCommit?: { commitId: string };
  autoCompleteSetBy?: IdentityRef;
  completionOptions?: GitPullRequestCompletionOptions;
  url: string;
  artifactId?: string;
}

export interface CommentPosition {
  line: number;
  offset: number;
}

export interface CommentThreadContext {
  filePath: string;
  leftFileStart?: CommentPosition | null;
  leftFileEnd?: CommentPosition | null;
  rightFileStart?: CommentPosition | null;
  rightFileEnd?: CommentPosition | null;
}

export type ThreadStatus = 'unknown' | 'active' | 'fixed' | 'wontFix' | 'closed' | 'byDesign' | 'pending';

export interface PullRequestComment {
  id: number;
  parentCommentId?: number;
  author: IdentityRef;
  content?: string;
  publishedDate?: string;
  lastUpdatedDate?: string;
  commentType?: 'unknown' | 'text' | 'codeChange' | 'system';
  isDeleted?: boolean;
  usersLiked?: IdentityRef[];
}

export interface PullRequestThread {
  id: number;
  publishedDate?: string;
  lastUpdatedDate?: string;
  status?: ThreadStatus;
  threadContext?: CommentThreadContext | null;
  pullRequestThreadContext?: {
    changeTrackingId?: number;
    iterationContext?: { firstComparingIteration: number; secondComparingIteration: number };
  } | null;
  comments: PullRequestComment[];
  isDeleted?: boolean;
  properties?: Record<string, { $type?: string; $value?: unknown }>;
}

export interface PullRequestIteration {
  id: number;
  description?: string;
  createdDate?: string;
  sourceRefCommit?: { commitId: string };
  targetRefCommit?: { commitId: string };
  commonRefCommit?: { commitId: string };
}

export interface PullRequestChange {
  changeTrackingId: number;
  changeId?: number;
  changeType: string;
  item: {
    objectId?: string;
    originalObjectId?: string;
    path: string;
    gitObjectType?: string;
    isFolder?: boolean;
  };
  originalPath?: string;
  sourceServerItem?: string;
}

export interface PullRequestChanges {
  changeEntries: PullRequestChange[];
  nextSkip?: number;
  nextTop?: number;
}

export interface GitCommitRef {
  commitId: string;
  comment?: string;
  author?: { name: string; email?: string; date?: string };
}

export interface GitStatus {
  state: 'notSet' | 'pending' | 'succeeded' | 'failed' | 'error' | 'notApplicable';
  description?: string;
  context?: { name: string; genre?: string };
  targetUrl?: string;
  creationDate?: string;
}

export interface PolicyEvaluationRecord {
  evaluationId: string;
  status?: 'queued' | 'running' | 'approved' | 'rejected' | 'notApplicable' | 'broken';
  configuration: {
    id: number;
    isBlocking?: boolean;
    isEnabled?: boolean;
    type: { id: string; displayName: string };
    settings?: { displayName?: string; [key: string]: unknown };
  };
  context?: { buildId?: number; isExpired?: boolean; [key: string]: unknown };
}

export interface ResourceRef {
  id: string;
  url?: string;
}

// ---------------------------------------------------------------------------------------
// Build / pipelines

export type BuildStatus = 'none' | 'inProgress' | 'completed' | 'cancelling' | 'postponed' | 'notStarted' | 'all';
export type BuildResult = 'none' | 'succeeded' | 'partiallySucceeded' | 'failed' | 'canceled';

export interface Build {
  id: number;
  buildNumber: string;
  status: BuildStatus;
  result?: BuildResult;
  queueTime?: string;
  startTime?: string;
  finishTime?: string;
  sourceBranch?: string;
  sourceVersion?: string;
  reason?: string;
  requestedFor?: IdentityRef;
  definition: { id: number; name: string; path?: string };
  project?: { id: string; name: string };
  _links?: { web?: { href: string } };
}

export interface BuildDefinitionReference {
  id: number;
  name: string;
  path: string;
  type?: string;
  queueStatus?: string;
  latestBuild?: Build;
  latestCompletedBuild?: Build;
  _links?: { web?: { href: string } };
}

export interface BuildDefinition extends BuildDefinitionReference {
  repository?: { id: string; name: string; type: string; defaultBranch?: string };
  variables?: Record<string, { value?: string; allowOverride?: boolean; isSecret?: boolean }>;
  process?: { type: number; yamlFilename?: string };
}

export type TimelineRecordState = 'pending' | 'inProgress' | 'completed';
export type TimelineRecordResult = 'succeeded' | 'succeededWithIssues' | 'failed' | 'canceled' | 'skipped' | 'abandoned';

export interface TimelineRecord {
  id: string;
  parentId?: string | null;
  type: string;
  name: string;
  identifier?: string;
  order?: number;
  state?: TimelineRecordState;
  result?: TimelineRecordResult | null;
  startTime?: string | null;
  finishTime?: string | null;
  log?: { id: number; url?: string } | null;
  errorCount?: number;
  warningCount?: number;
  issues?: { type: 'error' | 'warning'; message: string }[] | null;
  attempt?: number;
}

export interface Timeline {
  id: string;
  records: TimelineRecord[];
}

export interface PipelineApproval {
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'canceled' | 'skipped' | 'timedOut' | 'failed' | 'uninitiated' | 'undefined';
  createdOn?: string;
  instructions?: string;
  minRequiredApprovers?: number;
  steps?: { assignedApprover: IdentityRef; status: string; comment?: string }[];
  pipeline?: { id: string | number; name: string; owner?: { id: number; name: string; _links?: { web?: { href: string } } } };
}

// ---------------------------------------------------------------------------------------
// Releases (classic)

export interface ReleaseDefinition {
  id: number;
  name: string;
  path?: string;
  _links?: { web?: { href: string } };
}

export interface ReleaseEnvironment {
  id: number;
  name: string;
  status: 'undefined' | 'notStarted' | 'inProgress' | 'succeeded' | 'canceled' | 'rejected' | 'queued' | 'scheduled' | 'partiallySucceeded';
}

export interface Release {
  id: number;
  name: string;
  status: string;
  createdOn: string;
  createdBy?: IdentityRef;
  releaseDefinition: { id: number; name: string };
  environments?: ReleaseEnvironment[];
  _links?: { web?: { href: string } };
}
