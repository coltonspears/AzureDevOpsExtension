import { CreatePullRequestToHost, CreatePullRequestToWebview, CreatePullRequestViewState } from '../shared/messages';
import { button, emptyState, gatedButton, h, icon, installStatus, markdownContent, mount, onMessage, post, section } from './lib';

const WRITE_SCOPE = { id: 'vso.code_write', label: 'Code (Read & write)' };

let state: CreatePullRequestViewState | undefined;
let title = '';
let description = '';
let isDraft = false;
let autoComplete = false;
let preview = false;
let userEdited = { title: false, description: false };

const send = (message: CreatePullRequestToHost) => post(message);

function branchSelect(label: string, value: string | undefined, onChange: (value: string) => void): HTMLElement {
  return h(
    'div',
    { class: 'field' },
    h('label', null, label),
    h(
      'select',
      { onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value) },
      value ? null : h('option', { value: '' }, 'Select a branch'),
      ...(state?.branches ?? []).map(b => h('option', { value: b, selected: b === value }, b)),
    ),
  );
}

function render(): Node {
  if (!state) {
    return h('div', { class: 'loading' }, icon('loading', 'codicon-modifier-spin'), 'Loading…');
  }
  const s = state;
  if (s.error && !s.repositories.length) {
    return h('div', null, h('div', { class: 'header' }, h('h1', null, 'New Pull Request')), h('div', { class: 'error-banner' }, icon('error'), ' ', s.error, ' ', button('Retry', () => send({ type: 'refresh' }), { kind: 'link' })));
  }
  const local = s.localBranch;
  const sameBranch = s.source && s.target && s.source === s.target;
  const sourceMissing = s.source && !s.branches.includes(s.source);
  return h(
    'div',
    null,
    h('div', { class: 'header' }, h('div', { class: 'kicker' }, icon('git-pull-request-create'), 'Azure Repos'), h('h1', null, 'New Pull Request')),
    s.canCreate === 'denied'
      ? h(
          'div',
          { class: 'warn-banner' },
          icon('lock', 'warn'),
          h('div', null, h('b', null, 'Creating pull requests is locked. '), `Your PAT needs the ${WRITE_SCOPE.label} scope. `, button('How to enable', () => send({ type: 'requestAccess', scope: WRITE_SCOPE.id, action: 'create pull requests' }), { kind: 'link' })),
        )
      : null,
    local && local.unpublished
      ? h(
          'div',
          { class: 'warn-banner' },
          icon('cloud-upload', 'warn'),
          h('div', null, `Your current branch `, h('code', null, local.name), ' has not been pushed to Azure Repos yet. ', button('Publish Branch', () => send({ type: 'pushBranch' }), { kind: 'link', icon: 'cloud-upload' })),
        )
      : local && local.ahead > 0
        ? h(
            'div',
            { class: 'info-banner' },
            icon('info'),
            h('div', null, h('code', null, local.name), ` has ${local.ahead} local commit${local.ahead === 1 ? '' : 's'} that are not pushed. `, button('Push', () => send({ type: 'pushBranch' }), { kind: 'link', icon: 'cloud-upload' })),
          )
        : null,
    s.existing
      ? h(
          'div',
          { class: 'info-banner' },
          icon('git-pull-request'),
          h('div', null, `An active pull request already exists for these branches: !${s.existing.id} ${s.existing.title}. `, button('Open it', () => send({ type: 'openExisting' }), { kind: 'link' })),
        )
      : null,
    h(
      'div',
      { class: 'layout' },
      h(
        'div',
        null,
        h(
          'div',
          { class: 'grid-fields' },
          h(
            'div',
            { class: 'field' },
            h('label', null, 'Repository'),
            h(
              'select',
              { onchange: (e: Event) => send({ type: 'selectRepository', repositoryId: (e.target as HTMLSelectElement).value }) },
              ...s.repositories.map(r => h('option', { value: r.id, selected: r.id === s.repositoryId }, r.name)),
            ),
          ),
          branchSelect('Source branch', s.source, v => send({ type: 'selectBranches', source: v, target: s.target ?? '' })),
          branchSelect('Target branch', s.target, v => send({ type: 'selectBranches', source: s.source ?? '', target: v })),
        ),
        sameBranch ? h('div', { class: 'warn-banner' }, icon('warning'), 'Source and target branches must be different.') : null,
        sourceMissing ? h('div', { class: 'warn-banner' }, icon('warning'), `Branch ${s.source} does not exist in Azure Repos yet. Push it first.`) : null,
        h(
          'div',
          { class: 'field' },
          h('label', null, 'Title', h('span', { class: 'required' }, '*')),
          h('input', {
            type: 'text',
            class: 'title-input',
            value: title,
            'data-key': 'title',
            placeholder: 'Describe the change',
            oninput: (e: Event) => {
              title = (e.target as HTMLInputElement).value;
              userEdited.title = true;
            },
          }),
        ),
        h(
          'div',
          { class: 'field' },
          h(
            'label',
            null,
            'Description (Markdown) ',
            button(preview ? 'Edit' : 'Preview', () => ((preview = !preview), update()), { kind: 'link', icon: preview ? 'edit' : 'preview' }),
          ),
          preview
            ? h('div', { class: 'card' }, description ? markdownContent(description) : emptyState('Nothing to preview'))
            : h('textarea', {
                value: description,
                'data-key': 'description',
                style: 'min-height:180px',
                placeholder: 'What changed and why?',
                oninput: (e: Event) => {
                  description = (e.target as HTMLTextAreaElement).value;
                  userEdited.description = true;
                },
              }),
        ),
        h('label', { class: 'checkbox' }, h('input', { type: 'checkbox', checked: isDraft, onchange: (e: Event) => (isDraft = (e.target as HTMLInputElement).checked) }), 'Create as draft'),
        h('label', { class: 'checkbox' }, h('input', { type: 'checkbox', checked: autoComplete, onchange: (e: Event) => (autoComplete = (e.target as HTMLInputElement).checked) }), 'Set auto-complete (merge when policies pass)'),
        h(
          'div',
          { class: 'toolbar' },
          gatedButton(
            s.creating ? 'Creating…' : 'Create Pull Request',
            s.canCreate,
            WRITE_SCOPE,
            'create pull requests',
            () => send({ type: 'create', title, description, isDraft, autoComplete }),
            { kind: 'primary', icon: 'git-pull-request-create', disabled: s.creating || !s.source || !s.target || Boolean(sameBranch) || Boolean(sourceMissing) },
          ),
          button('Refresh', () => send({ type: 'refresh' }), { icon: 'refresh' }),
        ),
      ),
      h(
        'div',
        null,
        section(
          'Reviewers',
          s.reviewers.length
            ? h('ul', { class: 'list' }, ...s.reviewers.map(r => h('li', null, icon('person'), h('span', { class: 'grow' }, r.name), h('button', { class: 'btn btn-link', onclick: () => send({ type: 'removeReviewer', id: r.id }) }, icon('close')))))
            : emptyState('No reviewers'),
          button('Add reviewer', () => send({ type: 'addReviewer' }), { kind: 'link', icon: 'person-add' }),
        ),
        section(
          'Work items',
          s.workItems.length
            ? h('ul', { class: 'list' }, ...s.workItems.map(w => h('li', null, icon('issues'), h('span', { class: 'grow' }, `${w.id}: ${w.title}`), h('button', { class: 'btn btn-link', onclick: () => send({ type: 'removeWorkItem', id: w.id }) }, icon('close')))))
            : emptyState('None linked. IDs like #123 in the branch name or commits are linked automatically.'),
          button('Link work item', () => send({ type: 'addWorkItem' }), { kind: 'link', icon: 'link' }),
        ),
        section(
          `Commits (${s.commits.length})`,
          s.commits.length
            ? h('ul', { class: 'list' }, ...s.commits.map(c => h('li', null, icon('git-commit'), h('code', null, c.id.slice(0, 8)), h('span', { class: 'grow', title: c.message }, c.message))))
            : emptyState(s.loading ? 'Comparing branches…' : 'No commits to merge'),
        ),
      ),
    ),
  );
}

installStatus();
const update = mount(render);

onMessage<CreatePullRequestToWebview>(message => {
  if (message.type === 'state') {
    const previous = state;
    state = message.state;
    // Adopt suggestions from the host until the user types their own text.
    if (!userEdited.title || !previous) {
      title = state.title;
    }
    if (!userEdited.description || !previous) {
      description = state.description;
    }
    if (!previous) {
      isDraft = state.isDraft;
      userEdited = { title: false, description: false };
    }
    update();
  }
});

send({ type: 'ready' });
