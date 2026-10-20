import { CheckModel, PullRequestToHost, PullRequestToWebview, PullRequestViewState, ThreadModel } from '../shared/messages';
import { relativeTime } from '../util/format';
import {
  avatar,
  button,
  emptyState,
  gatedButton,
  h,
  icon,
  installStatus,
  markdownContent,
  mount,
  onMessage,
  post,
  section,
  setOrganization,
} from './lib';

const WRITE_SCOPE = { id: 'vso.code_write', label: 'Code (Read & write)' };
const VOTES = [
  { vote: 10, label: 'Approve', icon: 'pass-filled' },
  { vote: 5, label: 'Approve with suggestions', icon: 'pass' },
  { vote: -5, label: 'Wait for author', icon: 'clock' },
  { vote: -10, label: 'Reject', icon: 'error' },
  { vote: 0, label: 'Reset feedback', icon: 'discard' },
];
const VOTE_LABEL: Record<number, string> = {
  10: 'Approved',
  5: 'Approved with suggestions',
  0: 'No vote',
  [-5]: 'Waiting for author',
  [-10]: 'Rejected',
};
const VOTE_ICON: Record<number, string> = { 10: 'pass-filled', 5: 'pass', 0: 'circle-outline', [-5]: 'clock', [-10]: 'error' };
const MERGE_STRATEGIES = [
  { value: 'squash', label: 'Squash commit' },
  { value: 'noFastForward', label: 'Merge (no fast-forward)' },
  { value: 'rebase', label: 'Rebase and fast-forward' },
  { value: 'rebaseMerge', label: 'Semi-linear merge' },
];

let state: PullRequestViewState | undefined;
let tab: 'overview' | 'files' | 'commits' = 'overview';
let popover: 'vote' | 'complete' | null = null;
let editingTitle = false;
let editingDescription = false;
let titleDraft = '';
let descriptionDraft = '';
let newComment = '';
const replies: Record<number, string> = {};
let completion: { mergeStrategy: string; deleteSourceBranch: boolean; transitionWorkItems: boolean; mergeCommitMessage: string } | undefined;

const send = (message: PullRequestToHost) => post(message);
const canWrite = () => state?.canContribute ?? 'unknown';
const gated = (label: string, action: string, onClick: () => void, options: Parameters<typeof gatedButton>[5] = {}) =>
  gatedButton(label, canWrite(), WRITE_SCOPE, action, onClick, options);

function withMentions(markdown: string): string {
  const identities = state?.identities ?? {};
  return markdown.replace(/@<([0-9a-fA-F-]{36})>/g, (match, id: string) => (identities[id.toLowerCase()] ? `**@${identities[id.toLowerCase()]}**` : match));
}

// ---------------------------------------------------------------------------------------

function statusBadges(): HTMLElement[] {
  const pr = state!.pr!;
  const badges: HTMLElement[] = [];
  if (pr.isDraft) {
    badges.push(h('span', { class: 'badge muted' }, icon('git-pull-request-draft'), 'Draft'));
  }
  if (pr.status === 'completed') {
    badges.push(h('span', { class: 'badge ok' }, icon('git-merge'), 'Completed'));
  } else if (pr.status === 'abandoned') {
    badges.push(h('span', { class: 'badge muted' }, icon('git-pull-request-closed'), 'Abandoned'));
  } else {
    badges.push(h('span', { class: 'badge' }, icon('git-pull-request'), 'Active'));
  }
  if (pr.mergeStatus === 'conflicts') {
    badges.push(h('span', { class: 'badge bad' }, icon('warning'), 'Merge conflicts'));
  }
  if (pr.autoCompleteBy) {
    badges.push(h('span', { class: 'badge ok', title: `Set by ${pr.autoCompleteBy}` }, icon('rocket'), 'Auto-complete'));
  }
  for (const label of pr.labels) {
    badges.push(h('span', { class: 'badge muted' }, icon('tag'), label));
  }
  return badges;
}

function votePopover(): HTMLElement {
  return h(
    'div',
    { class: 'popover' },
    h(
      'ul',
      { class: 'list' },
      ...VOTES.map(v =>
        h(
          'li',
          {
            class: 'clickable',
            onclick: () => {
              popover = null;
              send({ type: 'vote', vote: v.vote });
            },
          },
          icon(v.icon, `vote-${v.vote}`),
          h('span', { class: 'grow' }, v.label),
          state?.pr?.myVote === v.vote && v.vote !== 0 ? icon('check') : null,
        ),
      ),
    ),
  );
}

function completionPopover(): HTMLElement {
  const pr = state!.pr!;
  completion ??= {
    mergeStrategy: pr.defaultMergeStrategy,
    deleteSourceBranch: pr.defaultDeleteSourceBranch,
    transitionWorkItems: pr.defaultTransitionWorkItems,
    mergeCommitMessage: pr.defaultMergeMessage,
  };
  const c = completion;
  const blocking = state!.checks.filter(check => check.blocking && check.state !== 'succeeded' && check.state !== 'notApplicable');
  return h(
    'div',
    { class: 'popover' },
    h('h3', null, `Complete into ${pr.target}`),
    blocking.length
      ? h('div', { class: 'warn-banner' }, icon('warning', 'warn'), h('div', null, `${blocking.length} required check${blocking.length === 1 ? ' has' : 's have'} not passed: ${blocking.map(b => b.name).join(', ')}. Azure DevOps may reject completion — consider auto-complete instead.`))
      : null,
    h(
      'div',
      { class: 'field' },
      h('label', null, 'Merge type'),
      h(
        'select',
        { onchange: (e: Event) => (c.mergeStrategy = (e.target as HTMLSelectElement).value) },
        ...MERGE_STRATEGIES.map(m => h('option', { value: m.value, selected: m.value === c.mergeStrategy }, m.label)),
      ),
    ),
    h(
      'div',
      { class: 'field' },
      h('label', null, 'Merge commit message'),
      h('textarea', { 'data-key': 'merge-message', value: c.mergeCommitMessage, oninput: (e: Event) => (c.mergeCommitMessage = (e.target as HTMLTextAreaElement).value) }),
    ),
    h('label', { class: 'checkbox' }, h('input', { type: 'checkbox', checked: c.deleteSourceBranch, onchange: (e: Event) => (c.deleteSourceBranch = (e.target as HTMLInputElement).checked) }), `Delete ${pr.source} after merging`),
    h('label', { class: 'checkbox' }, h('input', { type: 'checkbox', checked: c.transitionWorkItems, onchange: (e: Event) => (c.transitionWorkItems = (e.target as HTMLInputElement).checked) }), 'Complete associated work items after merging'),
    h(
      'div',
      { class: 'toolbar' },
      gated('Complete Merge', 'complete pull requests', () => {
        popover = null;
        send({ type: 'complete', ...c });
      }, { kind: 'primary', icon: 'git-merge' }),
      gated('Set Auto-complete', 'set auto-complete', () => {
        popover = null;
        send({ type: 'autoComplete', enable: true, mergeStrategy: c.mergeStrategy, deleteSourceBranch: c.deleteSourceBranch, transitionWorkItems: c.transitionWorkItems });
      }, { icon: 'rocket', title: 'Complete automatically once all policies pass' }),
      button('Cancel', () => ((popover = null), update()), { kind: 'link' }),
    ),
  );
}

function header(): HTMLElement {
  const pr = state!.pr!;
  const active = pr.status === 'active';
  const title = editingTitle
    ? h(
        'div',
        { class: 'input-row' },
        h('input', { class: 'title-input', type: 'text', value: titleDraft, 'data-key': 'title', oninput: (e: Event) => (titleDraft = (e.target as HTMLInputElement).value) }),
        button('Save', () => {
          editingTitle = false;
          send({ type: 'updateDetails', title: titleDraft });
        }, { kind: 'primary' }),
        button('Cancel', () => ((editingTitle = false), update())),
      )
    : h(
        'h1',
        null,
        pr.title,
        ' ',
        active && canWrite() !== 'denied'
          ? h('button', { class: 'btn btn-link', title: 'Edit title', onclick: () => ((editingTitle = true), (titleDraft = pr.title), update()) }, icon('edit'))
          : null,
      );

  const myVote = pr.myVote ?? 0;
  const actions: HTMLElement[] = [];
  if (active) {
    actions.push(
      gated(myVote ? VOTE_LABEL[myVote] : 'Approve', 'vote on pull requests', () => send({ type: 'vote', vote: myVote ? myVote : 10 }), {
        kind: 'primary',
        icon: VOTE_ICON[myVote] ?? 'pass-filled',
      }),
      gated('Vote', 'vote on pull requests', () => ((popover = popover === 'vote' ? null : 'vote'), update()), { icon: 'chevron-down' }),
    );
    if (!pr.isDraft) {
      actions.push(gated('Complete', 'complete pull requests', () => ((popover = popover === 'complete' ? null : 'complete'), update()), { icon: 'git-merge' }));
    }
    if (pr.autoCompleteBy) {
      actions.push(gated('Cancel Auto-complete', 'cancel auto-complete', () => send({ type: 'autoComplete', enable: false }), { icon: 'circle-slash' }));
    }
    actions.push(
      pr.isDraft
        ? gated('Publish', 'publish pull requests', () => send({ type: 'publish' }), { icon: 'eye' })
        : gated('Mark as Draft', 'mark pull requests as draft', () => send({ type: 'markDraft' }), { icon: 'git-pull-request-draft' }),
      gated('Abandon', 'abandon pull requests', () => send({ type: 'abandon' }), { kind: 'danger', icon: 'close' }),
    );
  } else if (pr.status === 'abandoned') {
    actions.push(gated('Reactivate', 'reactivate pull requests', () => send({ type: 'reactivate' }), { icon: 'debug-restart' }));
  }

  return h(
    'div',
    { class: 'header' },
    h('div', { class: 'kicker' }, h('b', null, `!${pr.id}`), h('span', null, pr.repository), ...statusBadges()),
    title,
    h(
      'div',
      { class: 'meta' },
      avatar(pr.author),
      h('span', null, h('b', null, pr.author), ' wants to merge ', h('code', null, pr.source), ' into ', h('code', null, pr.target)),
      h('span', null, `created ${relativeTime(pr.created)}`),
      pr.closed ? h('span', null, `closed ${relativeTime(pr.closed)}`) : null,
    ),
    h(
      'div',
      { class: 'toolbar' },
      ...actions,
      h('span', { class: 'spacer' }),
      button('Checkout', () => send({ type: 'checkout' }), { icon: 'git-branch', title: `Check out ${pr.source} locally` }),
      button('', () => send({ type: 'copyLink' }), { icon: 'link', title: 'Copy link' }),
      button('', () => send({ type: 'openInBrowser' }), { icon: 'link-external', title: 'Open in browser' }),
      button('', () => send({ type: 'refresh' }), { icon: 'refresh', title: 'Refresh' }),
    ),
    popover === 'vote' ? votePopover() : null,
    popover === 'complete' ? completionPopover() : null,
  );
}

function tabs(): HTMLElement {
  const make = (id: typeof tab, label: string) =>
    h('button', { class: `tab${tab === id ? ' active' : ''}`, onclick: () => ((tab = id), update()) }, label);
  return h(
    'div',
    { class: 'tabs' },
    make('overview', 'Overview'),
    make('files', `Files (${state!.files.length})`),
    make('commits', `Commits (${state!.commits.length})`),
  );
}

function description(): HTMLElement {
  const pr = state!.pr!;
  if (editingDescription) {
    return section(
      'Description',
      h('textarea', { 'data-key': 'description', value: descriptionDraft, style: 'min-height:200px', oninput: (e: Event) => (descriptionDraft = (e.target as HTMLTextAreaElement).value) }),
      h(
        'div',
        { class: 'reply-actions' },
        button('Cancel', () => ((editingDescription = false), update())),
        button('Save', () => {
          editingDescription = false;
          send({ type: 'updateDetails', description: descriptionDraft });
        }, { kind: 'primary' }),
      ),
    );
  }
  return section(
    h(
      'span',
      null,
      'Description ',
      pr.status === 'active' && canWrite() !== 'denied'
        ? h('button', { class: 'btn btn-link', title: 'Edit description', onclick: () => ((editingDescription = true), (descriptionDraft = pr.description), update()) }, icon('edit'))
        : null,
    ),
    pr.description ? h('div', { class: 'card' }, markdownContent(withMentions(pr.description))) : emptyState('No description'),
  );
}

function threadStatusBadge(status: string): HTMLElement {
  const resolved = ['fixed', 'closed', 'wontFix', 'byDesign'].includes(status);
  const label = { fixed: 'Resolved', closed: 'Closed', wontFix: "Won't fix", byDesign: 'By design', pending: 'Pending', active: 'Active' }[status] ?? 'Active';
  return h('span', { class: `badge ${resolved ? 'ok' : 'warn'}` }, label);
}

function threadView(thread: ThreadModel): HTMLElement {
  if (thread.isSystem) {
    return h('div', { class: 'system-event' }, icon('info'), markdownContent(withMentions(thread.comments[0]?.markdown ?? ''), 'rich'), h('span', { class: 'muted' }, relativeTime(thread.date)));
  }
  const resolved = ['fixed', 'closed', 'wontFix', 'byDesign'].includes(thread.status);
  return h(
    'div',
    { class: `thread${resolved ? ' resolved' : ''}` },
    h(
      'div',
      { class: 'thread-header' },
      thread.filePath
        ? h('a', { href: '#', onclick: (e: Event) => (e.preventDefault(), send({ type: 'openFile', path: thread.filePath!, line: thread.line })) }, icon('file'), ` ${thread.filePath}${thread.line ? `:${thread.line}` : ''}`)
        : h('span', null, icon('comment-discussion'), ' General comment'),
      h('span', { class: 'grow' }),
      thread.status !== 'unknown' ? threadStatusBadge(thread.status) : null,
      state?.pr?.status === 'active'
        ? resolved
          ? gated('Reactivate', 'reactivate comment threads', () => send({ type: 'setThreadStatus', threadId: thread.id, status: 'active' }), { kind: 'link' })
          : gated('Resolve', 'resolve comment threads', () => send({ type: 'setThreadStatus', threadId: thread.id, status: 'fixed' }), { kind: 'link', icon: 'check' })
        : null,
    ),
    ...thread.comments.map(c =>
      h(
        'div',
        { class: 'comment' },
        avatar(c.author),
        h('div', { class: 'body' }, h('div', { class: 'who' }, h('b', null, c.author), h('span', { class: 'time' }, relativeTime(c.date))), markdownContent(withMentions(c.markdown))),
      ),
    ),
    resolved
      ? null
      : h(
          'div',
          { class: 'reply-box' },
          h('textarea', {
            placeholder: 'Reply…',
            'data-key': `reply:${thread.id}`,
            value: replies[thread.id] ?? '',
            disabled: canWrite() === 'denied',
            oninput: (e: Event) => (replies[thread.id] = (e.target as HTMLTextAreaElement).value),
            onkeydown: (e: KeyboardEvent) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                sendReply(thread.id);
              }
            },
          }),
          h('div', { class: 'reply-actions' }, gated('Reply', 'reply to comments', () => sendReply(thread.id), { kind: 'primary' })),
        ),
  );
}

let pendingReply: number | 'new' | undefined;

function sendReply(threadId: number): void {
  const text = replies[threadId]?.trim();
  if (text) {
    pendingReply = threadId;
    send({ type: 'reply', threadId, text });
  }
}

function activity(): HTMLElement {
  const threads = state!.threads;
  const showSystem = threads.filter(t => !t.isSystem).length < 40;
  return section(
    `Activity (${threads.filter(t => !t.isSystem).length} threads)`,
    ...threads.filter(t => showSystem || !t.isSystem).map(threadView),
    h(
      'div',
      { class: 'thread' },
      h(
        'div',
        { class: 'reply-box' },
        h('textarea', {
          placeholder: canWrite() === 'denied' ? `Commenting requires the ${WRITE_SCOPE.label} scope` : 'Add a comment (Markdown supported)…',
          'data-key': 'new-comment',
          value: newComment,
          disabled: canWrite() === 'denied',
          oninput: (e: Event) => (newComment = (e.target as HTMLTextAreaElement).value),
          onkeydown: (e: KeyboardEvent) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              sendComment();
            }
          },
        }),
        h('div', { class: 'reply-actions' }, gated('Comment', 'comment on pull requests', sendComment, { kind: 'primary', icon: 'comment' })),
      ),
    ),
  );
}

function sendComment(): void {
  if (newComment.trim()) {
    pendingReply = 'new';
    send({ type: 'addComment', text: newComment });
  }
}

function checkIcon(check: CheckModel): HTMLElement {
  switch (check.state) {
    case 'succeeded':
      return icon('pass-filled', 'ok');
    case 'failed':
      return icon('error', 'bad');
    case 'running':
      return icon('loading', 'codicon-modifier-spin');
    case 'notApplicable':
      return icon('circle-slash', 'muted');
    default:
      return icon('clock', 'muted');
  }
}

function sidebar(): HTMLElement {
  const s = state!;
  const pr = s.pr!;
  const active = pr.status === 'active';
  return h(
    'div',
    null,
    section(
      'Reviewers',
      h(
        'ul',
        { class: 'list' },
        ...s.reviewers.map(r =>
          h(
            'li',
            null,
            avatar(r.name),
            h('span', { class: 'grow', title: r.name }, r.name, r.isMe ? h('span', { class: 'muted' }, ' (you)') : null),
            r.isRequired ? h('span', { class: 'badge muted' }, 'Required') : null,
            h('span', { class: `vote-${r.vote}`, title: VOTE_LABEL[r.vote] ?? '' }, icon(VOTE_ICON[r.vote] ?? 'circle-outline')),
            active && canWrite() !== 'denied' && !r.isRequired
              ? h('button', { class: 'btn btn-link', title: 'Remove reviewer', onclick: () => send({ type: 'removeReviewer', id: r.id }) }, icon('close'))
              : null,
          ),
        ),
      ),
      s.reviewers.length ? null : emptyState('No reviewers'),
      active ? gated('Add reviewer', 'add reviewers', () => send({ type: 'addReviewer' }), { kind: 'link', icon: 'person-add' }) : null,
    ),
    section(
      'Checks',
      s.checks.length
        ? h(
            'ul',
            { class: 'list' },
            ...s.checks.map(c =>
              h(
                'li',
                { class: c.url ? 'clickable' : '', onclick: c.url ? () => send({ type: 'openUrl', url: c.url! }) : undefined, title: c.detail ?? '' },
                checkIcon(c),
                h('span', { class: 'grow' }, c.name),
                c.blocking ? h('span', { class: 'badge muted' }, 'Required') : h('span', { class: 'muted' }, 'Optional'),
              ),
            ),
          )
        : emptyState('No policies or status checks'),
    ),
    section(
      'Work items',
      s.workItems.length
        ? h(
            'ul',
            { class: 'list' },
            ...s.workItems.map(w =>
              h('li', { class: 'clickable', onclick: () => send({ type: 'openWorkItem', id: w.id }) }, icon('issues'), h('span', { class: 'grow' }, `${w.type} ${w.id}: ${w.title}`), h('span', { class: 'badge muted' }, w.state)),
            ),
          )
        : emptyState('No linked work items'),
      gatedButton('Link work item', 'unknown', { id: 'vso.work_write', label: 'Work Items (Read & write)' }, 'link work items', () => send({ type: 'linkWorkItem' }), { kind: 'link', icon: 'link' }),
    ),
  );
}

function filesTab(): HTMLElement {
  const files = state!.files;
  if (!files.length) {
    return emptyState('No file changes in the latest iteration');
  }
  const letterClass: Record<string, string> = { A: 'ok', D: 'bad', R: 'warn', M: '' };
  return h(
    'ul',
    { class: 'list' },
    ...files.map(f =>
      h(
        'li',
        { class: 'clickable', onclick: () => send({ type: 'openFile', path: f.path }), title: `${f.changeType}${f.originalPath ? ` from ${f.originalPath}` : ''}` },
        h('span', { class: `badge muted ${letterClass[f.changeLetter] ?? ''}` }, f.changeLetter),
        h('span', { class: 'grow' }, f.path),
        f.comments ? h('span', { class: 'muted' }, icon('comment'), ` ${f.comments}`) : null,
      ),
    ),
  );
}

function commitsTab(): HTMLElement {
  const commits = state!.commits;
  if (!commits.length) {
    return emptyState('No commits');
  }
  return h(
    'ul',
    { class: 'list' },
    ...commits.map(c =>
      h('li', null, icon('git-commit'), h('code', null, c.id.slice(0, 8)), h('span', { class: 'grow', title: c.message }, c.message.split('\n')[0]), h('span', { class: 'muted' }, `${c.author} · ${relativeTime(c.date)}`)),
    ),
  );
}

function render(): Node {
  if (!state || (state.loading && !state.pr)) {
    return h('div', { class: 'loading' }, icon('loading', 'codicon-modifier-spin'), 'Loading pull request…');
  }
  if (state.error && !state.pr) {
    return h('div', { class: 'error-banner' }, icon('error'), ' ', state.error, ' ', button('Retry', () => send({ type: 'refresh' }), { kind: 'link' }));
  }
  const body =
    tab === 'files'
      ? filesTab()
      : tab === 'commits'
        ? commitsTab()
        : h('div', { class: 'layout' }, h('div', null, description(), activity()), sidebar());
  return h(
    'div',
    null,
    header(),
    state.error ? h('div', { class: 'error-banner' }, icon('error'), ' ', state.error) : null,
    state.canContribute === 'denied'
      ? h(
          'div',
          { class: 'warn-banner' },
          icon('lock', 'warn'),
          h(
            'div',
            null,
            h('b', null, 'Read-only review. '),
            `Your Personal Access Token does not include the ${WRITE_SCOPE.label} scope, so voting, commenting and completing are locked. `,
            button('How to enable', () => send({ type: 'requestAccess', scope: WRITE_SCOPE.id, action: 'review pull requests' }), { kind: 'link' }),
          ),
        )
      : null,
    tabs(),
    body,
  );
}

installStatus();
const update = mount(render);

onMessage<PullRequestToWebview>(message => {
  switch (message.type) {
    case 'state':
      state = message.state;
      if (state.organization) {
        setOrganization(state.organization.url, state.organization.name);
      }
      update();
      break;
    case 'commentPosted':
      if (pendingReply === 'new') {
        newComment = '';
      } else if (pendingReply !== undefined) {
        delete replies[pendingReply];
      }
      pendingReply = undefined;
      break;
  }
});

send({ type: 'ready' });
