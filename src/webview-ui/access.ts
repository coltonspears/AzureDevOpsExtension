import { AccessFlag, AccessToHost, AccessToWebview, AccessViewState } from '../shared/messages';
import { relativeTime } from '../util/format';
import { button, h, icon, installStatus, mount, onMessage, post, section } from './lib';

let state: AccessViewState | undefined;
const send = (message: AccessToHost) => post(message);

function stateBadge(value: AccessFlag): HTMLElement {
  if (value === 'granted') {
    return h('span', { class: 'state ok' }, icon('pass-filled'), 'Granted');
  }
  if (value === 'denied') {
    return h('span', { class: 'state warn' }, icon('lock'), 'Not granted');
  }
  return h('span', { class: 'state muted' }, icon('question'), 'Not verified');
}

function signedOut(): HTMLElement {
  return h(
    'div',
    null,
    h('div', { class: 'header' }, h('h1', null, 'Connect to Azure DevOps')),
    h('p', null, 'This extension talks to Azure DevOps with a Personal Access Token (PAT). After you paste one, it checks which scopes the token grants and shows exactly which features are available.'),
    button('Sign In with PAT', () => send({ type: 'signIn' }), { kind: 'primary', icon: 'key' }),
    section(
      'Creating a token',
      h(
        'ol',
        { class: 'steps' },
        h('li', null, 'In Azure DevOps, open ', h('b', null, 'User settings → Personal access tokens'), '.'),
        h('li', null, 'Choose ', h('b', null, '+ New Token'), ', pick the organization, and select ', h('b', null, 'Custom defined'), ' scopes.'),
        h('li', null, 'Enable the scopes below for full functionality, then create and copy the token.'),
      ),
      h('div', null, ...(state?.recommended ?? []).map(s => h('span', { class: 'kbd-chip' }, s))),
    ),
  );
}

function header(s: AccessViewState): HTMLElement {
  return h(
    'div',
    { class: 'header' },
    h('div', { class: 'kicker' }, icon('shield'), 'Personal Access Token'),
    h('h1', null, 'PAT Access'),
    h(
      'div',
      { class: 'meta' },
      h('span', null, icon('organization'), ' ', s.organization?.name, ' ', h('span', { class: 'muted' }, `(${s.organization?.url})`)),
      h('span', null, icon('account'), ' ', s.user?.name, s.user?.email ? ` · ${s.user.email}` : ''),
      h('span', null, icon('project'), ' ', s.project ?? h('i', null, 'no project selected')),
      s.checkedAt ? h('span', null, icon('history'), ` checked ${relativeTime(new Date(s.checkedAt).toISOString())}`) : null,
    ),
    h(
      'div',
      { class: 'toolbar' },
      button(s.checking ? 'Checking…' : 'Re-check Scopes', () => send({ type: 'recheck' }), {
        kind: 'primary',
        icon: s.checking ? 'loading codicon-modifier-spin' : 'refresh',
        disabled: s.checking,
      }),
      button('Edit Token in Azure DevOps', () => send({ type: 'openTokenSettings' }), { icon: 'link-external' }),
      button('Use a Different PAT', () => send({ type: 'updatePat' }), { icon: 'key' }),
      h('span', { class: 'spacer' }),
      button('Sign Out', () => send({ type: 'signOut' }), { kind: 'link', icon: 'sign-out' }),
    ),
  );
}

function banners(s: AccessViewState): HTMLElement[] {
  const result: HTMLElement[] = [];
  const denied = s.features.filter(f => f.state === 'denied');
  const missingScopes = [...new Set(denied.flatMap(f => f.requires.filter(r => r.state === 'denied').map(r => r.label)))];

  if (s.afterSignIn) {
    result.push(
      h(
        'div',
        { class: 'info-banner' },
        icon('pass-filled', 'ok'),
        h('div', null, h('b', null, `Signed in as ${s.user?.name}.`), ' Here is what this token can do. Features that need more access are marked with a ', icon('lock'), ' throughout the extension.'),
      ),
    );
  }

  if (s.fullAccess) {
    result.push(h('div', { class: 'info-banner' }, icon('verified-filled', 'ok'), h('div', null, h('b', null, 'Every scope the extension uses is granted.'), ' All features are available.')));
  } else if (denied.length) {
    result.push(
      h(
        'div',
        { class: 'warn-banner' },
        icon('lock', 'warn'),
        h(
          'div',
          null,
          h('b', null, `${denied.length} feature${denied.length === 1 ? ' is' : 's are'} locked by your token's scopes.`),
          h(
            'ol',
            { class: 'steps' },
            h('li', null, h('a', { href: s.tokenSettingsUrl }, 'Open your Personal Access Tokens'), ' in Azure DevOps and edit this token.'),
            h('li', null, 'Enable: ', ...missingScopes.map(label => h('span', { class: 'kbd-chip' }, label))),
            h('li', null, 'Save, then click ', h('b', null, 'Re-check Scopes'), '. Editing scopes keeps the same token, so there is nothing to paste again.'),
          ),
        ),
      ),
    );
  }

  if (!s.project) {
    result.push(
      h(
        'div',
        { class: 'info-banner' },
        icon('info'),
        h('div', null, 'Build, Release, Wiki and some other scopes can only be checked inside a project. ', button('Select Project', () => send({ type: 'selectProject' }), { kind: 'link' })),
      ),
    );
  }
  return result;
}

function features(s: AccessViewState): HTMLElement {
  const granted = s.features.filter(f => f.state === 'granted').length;
  return section(
    h('span', null, `Features · ${granted} of ${s.features.length} available`),
    h(
      'div',
      { class: 'feature-grid' },
      ...s.features.map(f =>
        h(
          'div',
          { class: `feature ${f.state}` },
          f.state === 'granted' ? icon('pass-filled', 'ok') : f.state === 'denied' ? icon('lock', 'warn') : icon('question', 'muted'),
          h(
            'div',
            null,
            h('b', null, f.label),
            h('div', null, f.description),
            h(
              'div',
              { class: 'requires' },
              'Requires ',
              ...f.requires.map(r => h('span', { class: `kbd-chip ${r.state === 'denied' ? 'warn' : ''}` }, r.label)),
              f.state === 'denied'
                ? button('How to enable', () => send({ type: 'requestAccess', scope: f.requires.find(r => r.state === 'denied')!.id, action: f.label.toLowerCase() }), { kind: 'link' })
                : null,
            ),
          ),
        ),
      ),
    ),
  );
}

function scopes(s: AccessViewState): HTMLElement {
  let lastArea = '';
  return section(
    'Scopes checked on this token',
    h(
      'table',
      { class: 'scope-table' },
      h('thead', null, h('tr', null, h('th', null, 'Scope'), h('th', null, 'Permission'), h('th', null, 'Status'), h('th', null, 'Details'))),
      h(
        'tbody',
        null,
        ...s.scopes.map(scope => {
          const first = scope.area !== lastArea;
          lastArea = scope.area;
          const detail = [scope.detail, scope.status ? `HTTP ${scope.status}` : '', scope.source === 'runtime' ? 'learned from use' : '']
            .filter(Boolean)
            .join(' · ');
          return h(
            'tr',
            { class: first ? 'area-start' : '' },
            h('td', null, first ? h('b', null, scope.area) : ''),
            h('td', { title: scope.description }, scope.level, h('div', { class: 'muted' }, scope.description)),
            h('td', null, stateBadge(scope.state)),
            h('td', { class: 'muted' }, detail || (scope.state === 'granted' ? 'Verified' : '')),
          );
        }),
      ),
    ),
    h(
      'p',
      { class: 'muted' },
      'Azure DevOps does not reveal a token\'s scopes directly, so each scope is verified with a harmless request (write scopes are tested against targets that cannot exist, so nothing is changed). Access is also learned automatically as you use the extension.',
    ),
  );
}

function recommended(s: AccessViewState): HTMLElement {
  return section(
    'Recommended scopes for a new token',
    h('div', null, ...s.recommended.map(label => h('span', { class: 'kbd-chip' }, label))),
    h('div', { class: 'toolbar' }, button('Copy List', () => send({ type: 'copyRecommended' }), { icon: 'copy' })),
    h('p', { class: 'muted' }, icon('lock'), ' Your token is stored in the operating system keychain (VS Code Secret Storage) and is only sent to your organization\'s Azure DevOps hosts.'),
  );
}

function render(): Node {
  if (!state) {
    return h('div', { class: 'loading' }, icon('loading', 'codicon-modifier-spin'), 'Loading…');
  }
  if (!state.signedIn) {
    return signedOut();
  }
  return h('div', null, header(state), ...banners(state), features(state), scopes(state), recommended(state));
}

installStatus();
const update = mount(render);
onMessage<AccessToWebview>(message => {
  if (message.type === 'state') {
    state = message.state;
    update();
  }
});
send({ type: 'ready' });
