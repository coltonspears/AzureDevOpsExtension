/**
 * Message contracts between the extension host and the webview UIs. Imported by both
 * the Node bundle and the browser bundles, so it must stay free of runtime imports.
 */

export type AccessFlag = 'granted' | 'denied' | 'unknown';

/** Messages every webview understands. */
export type CommonToHost =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'openUrl'; url: string }
  | { type: 'requestAccess'; scope: string; action: string }
  | { type: 'resolveImage'; url: string };

export type CommonToWebview =
  | { type: 'busy'; busy: boolean; label?: string }
  | { type: 'toast'; kind: 'info' | 'error'; message: string }
  | { type: 'imageResolved'; url: string; dataUri?: string };

// ---------------------------------------------------------------------------------------
// Access panel

export interface AccessViewState {
  signedIn: boolean;
  afterSignIn: boolean;
  checking: boolean;
  organization?: { name: string; url: string; kind: string };
  user?: { name: string; email?: string };
  project?: string;
  checkedAt?: number;
  checkedProject?: string;
  tokenSettingsUrl: string;
  fullAccess: boolean;
  features: {
    id: string;
    label: string;
    description: string;
    state: AccessFlag;
    requires: { id: string; label: string; state: AccessFlag }[];
  }[];
  scopes: {
    id: string;
    area: string;
    level: string;
    description: string;
    state: AccessFlag;
    detail?: string;
    status?: number;
    source?: string;
  }[];
  recommended: string[];
}

export type AccessToHost =
  | CommonToHost
  | { type: 'recheck' }
  | { type: 'updatePat' }
  | { type: 'signIn' }
  | { type: 'signOut' }
  | { type: 'selectProject' }
  | { type: 'openTokenSettings' }
  | { type: 'copyRecommended' };

export type AccessToWebview = CommonToWebview | { type: 'state'; state: AccessViewState };

// ---------------------------------------------------------------------------------------
// Work item panel

export type FieldKind = 'text' | 'number' | 'select' | 'date' | 'identity' | 'readonly' | 'tags';

export interface FieldModel {
  refName: string;
  name: string;
  kind: FieldKind;
  value: string;
  options?: string[];
  required?: boolean;
  help?: string;
}

export interface RichFieldModel {
  refName: string;
  name: string;
  html: string;
}

export interface RelationModel {
  index: number;
  kind: 'parent' | 'child' | 'related' | 'pullRequest' | 'commit' | 'branch' | 'hyperlink' | 'other';
  label: string;
  workItemId?: number;
  pullRequestId?: number;
  url?: string;
  title?: string;
  state?: string;
  type?: string;
}

export interface CommentModel {
  id: number;
  author: string;
  date: string;
  html: string;
}

export interface WorkItemViewState {
  loading: boolean;
  organization?: { url: string; name: string };
  error?: string;
  canEdit: AccessFlag;
  saving: boolean;
  item?: {
    id: number;
    rev: number;
    type: string;
    typeColor?: string;
    title: string;
    state: string;
    stateColor?: string;
    reason?: string;
    project: string;
    webUrl: string;
    createdBy: string;
    createdDate: string;
    changedBy: string;
    changedDate: string;
    fields: FieldModel[];
    richFields: RichFieldModel[];
    relations: RelationModel[];
  };
  comments: CommentModel[];
  commentsError?: string;
}

export type WorkItemToHost =
  | CommonToHost
  | { type: 'save'; changes: Record<string, string> }
  | { type: 'addComment'; text: string }
  | { type: 'pickIdentity'; field: string }
  | { type: 'openWorkItem'; id: number }
  | { type: 'openPullRequest'; id: number }
  | { type: 'addLink'; kind: 'parent' | 'child' | 'related' }
  | { type: 'removeLink'; index: number }
  | { type: 'createChild' }
  | { type: 'createBranch' }
  | { type: 'copyLink' }
  | { type: 'copyMarkdown' }
  | { type: 'openInBrowser' };

export type WorkItemToWebview =
  | CommonToWebview
  | { type: 'state'; state: WorkItemViewState }
  | { type: 'identityPicked'; field: string; value: string }
  | { type: 'saved' };

// ---------------------------------------------------------------------------------------
// Pull request panel

export interface ReviewerModel {
  id: string;
  name: string;
  vote: number;
  isRequired: boolean;
  isGroup: boolean;
  isMe: boolean;
}

export interface ThreadCommentModel {
  id: number;
  author: string;
  date: string;
  markdown: string;
  isMine: boolean;
}

export interface ThreadModel {
  id: number;
  status: string;
  filePath?: string;
  line?: number;
  isSystem: boolean;
  comments: ThreadCommentModel[];
  date: string;
}

export interface FileChangeModel {
  path: string;
  changeType: string;
  changeLetter: string;
  originalPath?: string;
  comments: number;
}

export interface CheckModel {
  name: string;
  state: 'succeeded' | 'failed' | 'running' | 'pending' | 'notApplicable';
  detail?: string;
  blocking: boolean;
  url?: string;
}

export interface PullRequestViewState {
  loading: boolean;
  organization?: { url: string; name: string };
  error?: string;
  canContribute: AccessFlag;
  pr?: {
    id: number;
    title: string;
    description: string;
    status: string;
    isDraft: boolean;
    mergeStatus?: string;
    author: string;
    isAuthor: boolean;
    created: string;
    closed?: string;
    source: string;
    target: string;
    repository: string;
    webUrl: string;
    myVote?: number;
    amReviewer: boolean;
    autoCompleteBy?: string;
    labels: string[];
    defaultMergeStrategy: string;
    defaultDeleteSourceBranch: boolean;
    defaultTransitionWorkItems: boolean;
    defaultMergeMessage: string;
  };
  reviewers: ReviewerModel[];
  threads: ThreadModel[];
  files: FileChangeModel[];
  commits: { id: string; message: string; author: string; date: string }[];
  checks: CheckModel[];
  workItems: { id: number; title: string; type: string; state: string }[];
  /** Display names for @<guid> mentions. */
  identities: Record<string, string>;
}

export type PullRequestToHost =
  | CommonToHost
  | { type: 'vote'; vote: number }
  | {
      type: 'complete';
      mergeStrategy: string;
      deleteSourceBranch: boolean;
      transitionWorkItems: boolean;
      mergeCommitMessage: string;
    }
  | { type: 'autoComplete'; enable: boolean; mergeStrategy?: string; deleteSourceBranch?: boolean; transitionWorkItems?: boolean }
  | { type: 'abandon' }
  | { type: 'reactivate' }
  | { type: 'publish' }
  | { type: 'markDraft' }
  | { type: 'addComment'; text: string }
  | { type: 'reply'; threadId: number; text: string }
  | { type: 'setThreadStatus'; threadId: number; status: string }
  | { type: 'openFile'; path: string; line?: number }
  | { type: 'openInBrowser' }
  | { type: 'checkout' }
  | { type: 'addReviewer' }
  | { type: 'removeReviewer'; id: string }
  | { type: 'openWorkItem'; id: number }
  | { type: 'linkWorkItem' }
  | { type: 'copyLink' }
  | { type: 'updateDetails'; title?: string; description?: string };

export type PullRequestToWebview = CommonToWebview | { type: 'state'; state: PullRequestViewState } | { type: 'commentPosted' };

// ---------------------------------------------------------------------------------------
// Create pull request panel

export interface CreatePullRequestViewState {
  loading: boolean;
  error?: string;
  canCreate: AccessFlag;
  repositories: { id: string; name: string }[];
  repositoryId?: string;
  branches: string[];
  source?: string;
  target?: string;
  title: string;
  description: string;
  isDraft: boolean;
  reviewers: { id: string; name: string }[];
  workItems: { id: number; title: string }[];
  commits: { id: string; message: string }[];
  existing?: { id: number; title: string };
  localBranch?: { name: string; unpublished: boolean; ahead: number };
  creating: boolean;
}

export type CreatePullRequestToHost =
  | CommonToHost
  | { type: 'selectRepository'; repositoryId: string }
  | { type: 'selectBranches'; source: string; target: string }
  | { type: 'addReviewer' }
  | { type: 'removeReviewer'; id: string }
  | { type: 'addWorkItem' }
  | { type: 'removeWorkItem'; id: number }
  | { type: 'pushBranch' }
  | { type: 'openExisting' }
  | { type: 'create'; title: string; description: string; isDraft: boolean; autoComplete: boolean };

export type CreatePullRequestToWebview = CommonToWebview | { type: 'state'; state: CreatePullRequestViewState };
