import { FieldModel, RelationModel, WorkItemToHost, WorkItemToWebview, WorkItemViewState } from '../shared/messages';
import { relativeTime } from '../util/format';
import {
  avatar,
  button,
  emptyState,
  gatedButton,
  h,
  htmlContent,
  icon,
  installStatus,
  mount,
  onMessage,
  post,
  sanitizeHtml,
  section,
  setOrganization,
} from './lib';

const WRITE_SCOPE = { id: 'vso.work_write', label: 'Work Items (Read & write)' };

let state: WorkItemViewState | undefined;
/** Unsaved edits keyed by field reference name. */
let drafts: Record<string, string> = {};
let commentDraft = '';
let commentPending = false;

const send = (message: WorkItemToHost) => post(message);

function original(ref: string): string {
  const item = state?.item;
  if (!item) {
    return '';
  }
  if (ref === 'System.Title') {
    return item.title;
  }
  return item.fields.find(f => f.refName === ref)?.value ?? item.richFields.find(f => f.refName === ref)?.html ?? '';
}

function setDraft(ref: string, value: string): void {
  if (value === original(ref)) {
    delete drafts[ref];
  } else {
    drafts[ref] = value;
  }
  updateDirty();
}

function current(ref: string): string {
  return ref in drafts ? drafts[ref] : original(ref);
}

function isDirty(): boolean {
  return Object.keys(drafts).length > 0;
}

function updateDirty(): void {
  const dirty = isDirty();
  document.getElementById('dirty-dot')?.toggleAttribute('hidden', !dirty);
  const save = document.getElementById('save-button') as HTMLButtonElement | null;
  if (save && !save.classList.contains('locked')) {
    save.disabled = !dirty || Boolean(state?.saving);
  }
  const discard = document.getElementById('discard-button') as HTMLButtonElement | null;
  if (discard) {
    discard.hidden = !dirty;
  }
}

function save(): void {
  if (!isDirty() || state?.saving) {
    return;
  }
  send({ type: 'save', changes: { ...drafts } });
}

const readOnly = () => state?.canEdit === 'denied';

// ---------------------------------------------------------------------------------------

function fieldInput(field: FieldModel): HTMLElement {
  const value = current(field.refName);
  const key = `field:${field.refName}`;
  const disabled = readOnly() || field.kind === 'readonly';
  const onInput = (e: Event) => setDraft(field.refName, (e.target as HTMLInputElement).value);
  let control: HTMLElement;
  switch (field.kind) {
    case 'select':
      control = h(
        'select',
        { 'data-key': key, disabled, onchange: onInput },
        field.required ? null : h('option', { value: '' }, ''),
        ...(field.options ?? []).map(option => h('option', { value: option, selected: option === value }, option)),
      );
      (control as HTMLSelectElement).value = value;
      break;
    case 'number':
      control = h('input', { type: 'number', step: 'any', value, 'data-key': key, disabled, oninput: onInput });
      break;
    case 'date':
      control = h('input', { type: 'date', value, 'data-key': key, disabled, oninput: onInput });
      break;
    case 'identity':
      control = h(
        'div',
        { class: 'input-row' },
        h('input', { type: 'text', value, 'data-key': key, id: key, disabled, oninput: onInput, placeholder: 'Unassigned' }),
        disabled ? null : button('', () => send({ type: 'pickIdentity', field: field.refName }), { icon: 'search', title: 'Find a person' }),
      );
      break;
    case 'tags':
      control = h('input', { type: 'text', value, 'data-key': key, disabled, oninput: onInput, placeholder: 'tag1; tag2' });
      break;
    case 'readonly':
      control = h('input', { type: 'text', value, disabled: true });
      break;
    default:
      control = h('input', { type: 'text', value, 'data-key': key, disabled, oninput: onInput });
  }
  return h(
    'div',
    { class: 'field', title: field.help ?? '' },
    h('label', null, field.name, field.required ? h('span', { class: 'required' }, '*') : null, field.refName in drafts ? h('span', { class: 'dirty-dot' }) : null),
    control,
  );
}

/** Copies the editor's HTML, restoring original URLs of images that were inlined for display. */
function editorHtml(editor: HTMLElement): string {
  const clone = editor.cloneNode(true) as HTMLElement;
  clone.querySelectorAll<HTMLImageElement>('img[data-src]').forEach(img => {
    img.setAttribute('src', img.dataset.src!);
    img.removeAttribute('data-src');
  });
  return clone.innerHTML;
}

function richField(field: { refName: string; name: string }): HTMLElement {
  const editable = !readOnly();
  const editor = h('div', {
    class: 'rich-editor rich',
    contenteditable: editable ? 'true' : 'false',
    'data-key': `rich:${field.refName}`,
    oninput: () => setDraft(field.refName, editorHtml(editor)),
  });
  editor.innerHTML = sanitizeHtml(current(field.refName));
  const command = (name: string, value?: string) => () => {
    editor.focus();
    document.execCommand(name, false, value);
    setDraft(field.refName, editorHtml(editor));
  };
  const toolbar = editable
    ? h(
        'div',
        { class: 'editor-toolbar' },
        h('button', { title: 'Bold', onclick: command('bold') }, icon('bold')),
        h('button', { title: 'Italic', onclick: command('italic') }, icon('italic')),
        h('button', { title: 'Bulleted list', onclick: command('insertUnorderedList') }, icon('list-unordered')),
        h('button', { title: 'Numbered list', onclick: command('insertOrderedList') }, icon('list-ordered')),
        h('button', { title: 'Code', onclick: command('formatBlock', 'pre') }, icon('code')),
        h('button', { title: 'Clear formatting', onclick: command('removeFormat') }, icon('clear-all')),
      )
    : null;
  return section(h('span', null, field.name, field.refName in drafts ? ' •' : ''), toolbar, editor);
}

const RELATION_GROUPS: { kind: RelationModel['kind']; title: string }[] = [
  { kind: 'parent', title: 'Parent' },
  { kind: 'child', title: 'Children' },
  { kind: 'related', title: 'Related' },
  { kind: 'pullRequest', title: 'Pull requests' },
  { kind: 'branch', title: 'Branches' },
  { kind: 'commit', title: 'Commits' },
  { kind: 'hyperlink', title: 'Hyperlinks' },
  { kind: 'other', title: 'Other links' },
];

function relationRow(relation: RelationModel): HTMLElement {
  const remove = readOnly()
    ? null
    : h('button', { class: 'btn btn-link', title: 'Remove link', onclick: (e: Event) => (e.stopPropagation(), send({ type: 'removeLink', index: relation.index })) }, icon('close'));
  if (relation.workItemId) {
    return h(
      'li',
      { class: 'clickable', onclick: () => send({ type: 'openWorkItem', id: relation.workItemId! }) },
      icon('link'),
      h('span', { class: 'grow' }, `${relation.type ?? ''} ${relation.workItemId}: ${relation.title ?? ''}`),
      relation.state ? h('span', { class: 'badge muted' }, relation.state) : null,
      relation.kind === 'other' ? h('span', { class: 'muted' }, relation.label) : null,
      remove,
    );
  }
  if (relation.pullRequestId) {
    return h(
      'li',
      { class: 'clickable', onclick: () => send({ type: 'openPullRequest', id: relation.pullRequestId! }) },
      icon('git-pull-request'),
      h('span', { class: 'grow' }, relation.title ?? ''),
      remove,
    );
  }
  if (relation.url) {
    return h('li', { class: 'clickable', onclick: () => send({ type: 'openUrl', url: relation.url! }) }, icon('globe'), h('span', { class: 'grow' }, relation.title ?? relation.url), remove);
  }
  return h('li', null, icon(relation.kind === 'branch' ? 'git-branch' : relation.kind === 'commit' ? 'git-commit' : 'link'), h('span', { class: 'grow' }, relation.title ?? relation.label), remove);
}

function links(relations: RelationModel[]): HTMLElement {
  const groups = RELATION_GROUPS.map(g => ({ ...g, items: relations.filter(r => r.kind === g.kind) })).filter(g => g.items.length);
  const canWrite = state?.canEdit ?? 'unknown';
  const action = (label: string, kind: 'parent' | 'child' | 'related') =>
    gatedButton(label, canWrite, WRITE_SCOPE, 'link work items', () => send({ type: 'addLink', kind }), { kind: 'link', icon: 'add' });
  return section(
    'Links',
    groups.length ? null : emptyState('No links'),
    ...groups.map(g => h('div', null, h('h3', null, g.title), h('ul', { class: 'list' }, ...g.items.map(relationRow)))),
    h(
      'div',
      { class: 'toolbar' },
      action('Parent', 'parent'),
      action('Child', 'child'),
      action('Related', 'related'),
      gatedButton('New child', canWrite, WRITE_SCOPE, 'create work items', () => send({ type: 'createChild' }), { kind: 'link', icon: 'new-file' }),
    ),
  );
}

function discussion(): HTMLElement {
  const comments = state?.comments ?? [];
  const canWrite = state?.canEdit ?? 'unknown';
  return section(
    `Discussion (${comments.length})`,
    state?.commentsError ? h('div', { class: 'warn-banner' }, icon('warning'), state.commentsError) : null,
    h(
      'div',
      { class: 'thread' },
      ...comments.map(c =>
        h(
          'div',
          { class: 'comment' },
          avatar(c.author),
          h('div', { class: 'body' }, h('div', { class: 'who' }, h('b', null, c.author), h('span', { class: 'time' }, relativeTime(c.date))), htmlContent(c.html)),
        ),
      ),
      h(
        'div',
        { class: 'reply-box' },
        h('textarea', {
          placeholder: canWrite === 'denied' ? 'Commenting requires the Work Items (Read & write) scope' : 'Add a comment…',
          'data-key': 'new-comment',
          value: commentDraft,
          disabled: canWrite === 'denied',
          oninput: (e: Event) => (commentDraft = (e.target as HTMLTextAreaElement).value),
          onkeydown: (e: KeyboardEvent) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              addComment();
            }
          },
        }),
        h('div', { class: 'reply-actions' }, gatedButton('Comment', canWrite, WRITE_SCOPE, 'comment on work items', addComment, { kind: 'primary', icon: 'comment' })),
      ),
    ),
  );
}

function addComment(): void {
  if (!commentDraft.trim()) {
    return;
  }
  commentPending = true;
  send({ type: 'addComment', text: commentDraft });
}

function header(): HTMLElement {
  const item = state!.item!;
  const canWrite = state!.canEdit;
  const saveButton =
    canWrite === 'denied'
      ? gatedButton('Save', canWrite, WRITE_SCOPE, 'edit work items', save, { kind: 'primary' })
      : h(
          'button',
          { class: 'btn btn-primary', id: 'save-button', disabled: !isDirty() || state!.saving, onclick: save, title: 'Save (Ctrl+S)' },
          icon(state!.saving ? 'loading codicon-modifier-spin' : 'save'),
          state!.saving ? 'Saving…' : 'Save',
        );
  return h(
    'div',
    { class: 'header' },
    h(
      'div',
      { class: 'title-row' },
      h('div', { class: 'type-bar', style: `background:${item.typeColor ?? 'var(--vscode-focusBorder)'}` }),
      h(
        'div',
        { class: 'title-block' },
        h(
          'div',
          { class: 'kicker' },
          h('b', null, `${item.type} ${item.id}`),
          h('span', { class: 'badge muted' }, h('span', { class: 'dirty-dot', style: `background:${item.stateColor ?? 'var(--muted)'}` }), item.state),
          item.reason ? h('span', { class: 'muted' }, item.reason) : null,
          h('span', { class: 'dirty-dot', id: 'dirty-dot', hidden: !isDirty(), title: 'Unsaved changes' }),
        ),
        h('input', {
          class: 'title-input',
          type: 'text',
          value: current('System.Title'),
          'data-key': 'title',
          disabled: readOnly(),
          oninput: (e: Event) => setDraft('System.Title', (e.target as HTMLInputElement).value),
        }),
        h(
          'div',
          { class: 'meta' },
          h('span', null, `Created by ${item.createdBy} ${relativeTime(item.createdDate)}`),
          h('span', null, `Updated by ${item.changedBy} ${relativeTime(item.changedDate)}`),
          h('span', null, item.project),
        ),
      ),
    ),
    h(
      'div',
      { class: 'toolbar' },
      saveButton,
      h('button', { class: 'btn btn-secondary', id: 'discard-button', hidden: !isDirty(), onclick: () => ((drafts = {}), update()) }, icon('discard'), 'Discard'),
      button('Refresh', () => send({ type: 'refresh' }), { icon: 'refresh' }),
      h('span', { class: 'spacer' }),
      button('Create Branch', () => send({ type: 'createBranch' }), { icon: 'git-branch', title: 'Create a local git branch for this work item' }),
      button('Copy for AI', () => send({ type: 'copyMarkdown' }), { icon: 'sparkle', title: 'Copy as Markdown to paste into Cursor chat' }),
      button('Copy Link', () => send({ type: 'copyLink' }), { icon: 'link' }),
      button('Open in Browser', () => send({ type: 'openInBrowser' }), { icon: 'link-external' }),
    ),
  );
}

function render(): Node {
  if (!state || (state.loading && !state.item)) {
    return h('div', { class: 'loading' }, icon('loading', 'codicon-modifier-spin'), 'Loading work item…');
  }
  if (state.error && !state.item) {
    return h('div', { class: 'error-banner' }, icon('error'), ' ', state.error, ' ', button('Retry', () => send({ type: 'refresh' }), { kind: 'link' }));
  }
  const item = state.item!;
  return h(
    'div',
    null,
    header(),
    state.error ? h('div', { class: 'error-banner' }, icon('error'), ' ', state.error) : null,
    readOnly()
      ? h(
          'div',
          { class: 'warn-banner' },
          icon('lock', 'warn'),
          h(
            'div',
            null,
            h('b', null, 'Read-only. '),
            'Your Personal Access Token does not include the ',
            h('b', null, WRITE_SCOPE.label),
            ' scope, so this work item cannot be edited or commented on. ',
            button('How to enable', () => send({ type: 'requestAccess', scope: WRITE_SCOPE.id, action: 'edit work items' }), { kind: 'link' }),
          ),
        )
      : null,
    h(
      'div',
      { class: 'layout' },
      h('div', null, ...item.richFields.map(richField), discussion()),
      h('div', null, section('Details', h('div', { class: 'card' }, ...item.fields.map(fieldInput))), links(item.relations)),
    ),
  );
}

installStatus();
const update = mount(render);

document.addEventListener('keydown', e => {
  if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    save();
  }
});

onMessage<WorkItemToWebview>(message => {
  switch (message.type) {
    case 'state':
      state = message.state;
      if (state.organization) {
        setOrganization(state.organization.url, state.organization.name);
      }
      update();
      break;
    case 'saved':
      if (commentPending) {
        commentDraft = '';
        commentPending = false;
      } else {
        drafts = {};
      }
      break;
    case 'identityPicked': {
      setDraft(message.field, message.value);
      const input = document.getElementById(`field:${message.field}`) as HTMLInputElement | null;
      if (input) {
        input.value = message.value;
      }
      break;
    }
    case 'busy':
      if (!message.busy) {
        commentPending = false;
      }
      break;
  }
});

send({ type: 'ready' });
